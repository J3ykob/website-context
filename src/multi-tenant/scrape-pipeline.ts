/**
 * Reusable scrape+embed pipeline for a tenant.
 * Crawls the site, builds context, embeds into Qdrant, and saves metadata.
 */

import { existsSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { crawlSite, closeBrowser } from "../scraper/index.js";
import { buildContext } from "../context/index.js";
import { BGEEmbeddingProvider } from "../embeddings/bge-provider.js";
import { QdrantVectorStore } from "../embeddings/qdrant-store.js";
import { embedChunks } from "../embeddings/pipeline.js";
import { scrapeGooglePlaces, placesToChunks } from "../scraper/google-places.js";
import { auditBusinessInfo, businessInfoToNotes } from "./business-audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(__dirname, "../../data");

export interface ScrapePipelineResult {
  pages: number;
  chunks: number;
}

/**
 * Scrapes a tenant's site, builds context, embeds into Qdrant, and saves metadata.
 */
export async function scrapeTenant(
  tenantId: string,
  siteUrl: string,
  maxPages: number
): Promise<ScrapePipelineResult> {
  const collection = `wctx_${tenantId}`;

  const provider = new BGEEmbeddingProvider({
    host: process.env.BGE_HOST,
    port: process.env.BGE_PORT ? parseInt(process.env.BGE_PORT) : undefined,
  });

  const store = new QdrantVectorStore({
    host: process.env.QDRANT_HOST,
    port: process.env.QDRANT_PORT ? parseInt(process.env.QDRANT_PORT) : undefined,
    collection,
    createIfMissing: true,
  });

  // Clear old vectors before re-scraping (stale chunks cause retrieval issues)
  const qdrantHost = process.env.QDRANT_HOST || "152.53.243.28";
  const qdrantPort = process.env.QDRANT_PORT || "6333";
  try {
    await fetch(`http://${qdrantHost}:${qdrantPort}/collections/${collection}`, { method: "DELETE" });
    console.log(`[scrape-pipeline] Cleared old collection ${collection}`);
  } catch {}

  // Crawl site first (uses shared browser)
  console.log(`[scrape-pipeline] Crawling ${siteUrl} (max ${maxPages} pages) for tenant ${tenantId}`);
  const crawlResult = await crawlSite(siteUrl, { maxPages, maxDepth: 3, rateLimit: 800 });
  await closeBrowser();

  const pagesScraped = crawlResult.stats.successPages;
  console.log(`[scrape-pipeline] ${pagesScraped} pages scraped`);

  // Build context
  const context = await buildContext(crawlResult);
  await closeBrowser();
  console.log(`[scrape-pipeline] ${context.chunks.length} chunks built`);

  // Scrape Google Maps data (reviews, rating, hours, etc.)
  try {
    const domain = new URL(siteUrl).hostname;
    const businessName = domain.replace(/^www\./, "").split(".")[0];
    const tld = domain.split(".").pop() || "";
    const tldToCountry: Record<string, string> = {
      pl: "Poland", uk: "United Kingdom", de: "Germany", fr: "France",
      it: "Italy", es: "Spain", nl: "Netherlands", se: "Sweden",
      pt: "Portugal", be: "Belgium", at: "Austria", cz: "Czech Republic",
      dk: "Denmark", no: "Norway", ie: "Ireland", ch: "Switzerland",
      fi: "Finland", hu: "Hungary", ro: "Romania", gr: "Greece",
    };
    const location = tldToCountry[tld] || "";
    console.log(`[scrape-pipeline] Scraping Google Maps for "${businessName} ${location}"...`);

    const placesData = await Promise.race([
      scrapeGooglePlaces(businessName, location),
      new Promise<null>((_, reject) => setTimeout(() => reject(new Error("Google Maps timeout (30s)")), 30000)),
    ]);
    if (placesData && placesData.name) {
      const placesChunks = placesToChunks(placesData, tenantId);
      context.chunks.push(...placesChunks);
      console.log(`[scrape-pipeline] Added ${placesChunks.length} chunks from Google Maps (${placesData.reviewCount || 0} reviews, rating: ${placesData.rating || "N/A"})`);
    } else {
      console.log(`[scrape-pipeline] No Google Maps data found for "${businessName}"`);
    }
  } catch (err) {
    console.log(`[scrape-pipeline] Google Maps scrape skipped: ${(err as Error).message}`);
  }

  // Embed into Qdrant
  const embedResult = await embedChunks(context.chunks, provider, store);
  console.log(`[scrape-pipeline] ${embedResult.embeddedChunks} chunks embedded`);

  if (context.chunks.length > 0 && embedResult.embeddedChunks < Math.min(3, context.chunks.length)) {
    throw new Error(`Embedding failed: only ${embedResult.embeddedChunks}/${context.chunks.length} chunks embedded`);
  }

  // Save context metadata (siteMap, flows, page list — NOT chunks)
  const tenantDir = resolve(DATA_ROOT, tenantId);
  if (!existsSync(tenantDir)) {
    mkdirSync(tenantDir, { recursive: true });
  }

  const contextMeta = {
    tenantId,
    siteUrl,
    siteMap: context.siteMap,
    flows: context.flows,
    pages: context.pages.map((p) => ({
      id: p.id,
      url: p.url,
      title: p.title,
      description: p.description,
    })),
    lastScrapedAt: new Date().toISOString(),
    pagesCount: pagesScraped,
    chunksCount: embedResult.embeddedChunks,
  };

  await writeFile(
    resolve(tenantDir, "context-meta.json"),
    JSON.stringify(contextMeta, null, 2)
  );

  // Auto-extract business info and save as context notes + gap report
  try {
    const bizInfo = auditBusinessInfo(context.chunks);
    const autoNotes = businessInfoToNotes(bizInfo);
    await writeFile(
      resolve(tenantDir, "business-info.json"),
      JSON.stringify({ ...bizInfo, autoNotes, auditedAt: new Date().toISOString() }, null, 2)
    );
    if (autoNotes.length > 0) {
      await writeFile(
        resolve(tenantDir, "auto-context-notes.json"),
        JSON.stringify(autoNotes, null, 2)
      );
    }
    console.log(`[scrape-pipeline] Business audit: ${autoNotes.length} facts found, ${bizInfo.gaps.length} gaps`);
  } catch (err) {
    console.log(`[scrape-pipeline] Business audit skipped: ${(err as Error).message}`);
  }

  // Take screenshot only if one doesn't already exist (saves memory on re-scrapes)
  const screenshotPath = resolve(DATA_ROOT, tenantId, "screenshot.png");
  if (!existsSync(screenshotPath)) {
    try {
      const { chromium } = await import("playwright");
      const browserlessToken = process.env.BROWSERLESS_TOKEN || "";
      const browser = browserlessToken
        ? await chromium.connectOverCDP(`wss://chrome.browserless.io?token=${browserlessToken}`)
        : await chromium.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
            executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
          });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);

      const screenshotDir = resolve(DATA_ROOT, tenantId);
      if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({
        path: screenshotPath,
        fullPage: false,
      });
      console.log(`[scrape-pipeline] Screenshot saved for ${tenantId}`);
      await browser.close();
    } catch (err) {
      console.log(`[scrape-pipeline] Screenshot skipped: ${(err as Error).message}`);
    }
  } else {
    console.log(`[scrape-pipeline] Screenshot already exists for ${tenantId}, skipping`);
  }

  return {
    pages: pagesScraped,
    chunks: embedResult.embeddedChunks,
  };
}
