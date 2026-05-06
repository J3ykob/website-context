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

  // Take a full-page screenshot for the demo page background
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox"],
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.goto(siteUrl, { waitUntil: "networkidle", timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(2000);

    const screenshotDir = resolve(DATA_ROOT, tenantId);
    if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: resolve(screenshotDir, "screenshot.png"),
      fullPage: true,
    });
    console.log(`[scrape-pipeline] Screenshot saved for ${tenantId}`);
    await browser.close();
  } catch (err) {
    console.log(`[scrape-pipeline] Screenshot skipped: ${(err as Error).message}`);
  }

  // Crawl site
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
    const location = "Warszawa Poland"; // TODO: detect from site content
    console.log(`[scrape-pipeline] Scraping Google Maps for "${businessName} ${location}"...`);

    const placesData = await scrapeGooglePlaces(businessName, location);
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

  return {
    pages: pagesScraped,
    chunks: embedResult.embeddedChunks,
  };
}
