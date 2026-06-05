/**
 * Reusable scrape+embed pipeline for a tenant.
 * Crawls the site, builds context, embeds into Cloudflare Vectorize, and saves metadata.
 */

import { existsSync, mkdirSync } from "fs";
import { writeFile, readFile } from "fs/promises";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { crawlSite, closeBrowser } from "../scraper/index.js";
import { buildContext } from "../context/index.js";
import { BGEEmbeddingProvider } from "../embeddings/bge-provider.js";
import { CloudflareVectorizeStore } from "../embeddings/vectorize-store.js";
import { embedChunks } from "../embeddings/pipeline.js";
import { scrapeGooglePlaces, placesToChunks } from "../scraper/google-places.js";
import { auditBusinessInfo, businessInfoToNotes } from "./business-audit.js";
import { uploadToR2, downloadFromR2 } from "../storage/r2.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(__dirname, "../../data");

export interface ScrapePipelineResult {
  pages: number;
  chunks: number;
}

/**
 * Scrapes a tenant's site, builds context, embeds into Cloudflare Vectorize, and saves metadata.
 */
export async function scrapeTenant(
  tenantId: string,
  siteUrl: string,
  maxPages: number
): Promise<ScrapePipelineResult> {
  const provider = new BGEEmbeddingProvider({
    host: process.env.BGE_HOST,
    port: process.env.BGE_PORT ? parseInt(process.env.BGE_PORT) : undefined,
  });

  // Cloudflare Vectorize is the only vector store in production (CF_API_TOKEN is
  // always set on Render/VPS). Kept as a constant so the vector-op guards below read
  // clearly; the Qdrant vector fallback was dead code and has been removed.
  const useVectorize = true;
  const store = new CloudflareVectorizeStore({ tenantId });
  console.log(`[scrape-pipeline] Using Cloudflare Vectorize for ${tenantId}`);

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

  // Site content captured BEFORE Google Maps augmentation. Maps data (reviews,
  // hours) is a SUPPLEMENT, never a substitute — a demo grounded only on Maps for a
  // dead/SPA/blocked site (0 site chunks) would answer about the wrong thing.
  const siteChunks = context.chunks.length;

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

    // scrapeGooglePlaces self-bounds (an internal watchdog closes its own browser),
    // so no external race that would abandon a still-running Chromium.
    const placesData = await scrapeGooglePlaces(businessName, location, 30000);
    if (placesData && placesData.name) {
      // The Maps lookup is name-based and fuzzy. If it returned a website, require
      // its host to match this site before trusting it — otherwise it may be a
      // different business's reviews/hours. (Null website = can't verify; keep it.)
      let sameBiz = true;
      if (placesData.website) {
        try { sameBiz = new URL(placesData.website).hostname.replace(/^www\./, "") === domain.replace(/^www\./, ""); } catch { sameBiz = false; }
      }
      if (sameBiz) {
        const placesChunks = placesToChunks(placesData, tenantId);
        context.chunks.push(...placesChunks);
        console.log(`[scrape-pipeline] Added ${placesChunks.length} chunks from Google Maps (${placesData.reviewCount || 0} reviews, rating: ${placesData.rating || "N/A"})`);
      } else {
        console.log(`[scrape-pipeline] Skipped Google Maps data — website mismatch (${placesData.website} vs ${domain})`);
      }
    } else {
      console.log(`[scrape-pipeline] No Google Maps data found for "${businessName}"`);
    }
  } catch (err) {
    console.log(`[scrape-pipeline] Google Maps scrape skipped: ${(err as Error).message}`);
  }

  // GATE: a scrape that produced zero chunks cannot back a grounded demo - the
  // site is dead, a JS-only SPA, or blocking the crawler. Fail loudly so the
  // caller quarantines the tenant instead of registering it 'active' with 0
  // vectors (an ungrounded demo that looks live). The post-embed verification
  // below only runs when chunks.length > 0, so without this gate a 0-chunk
  // scrape slips straight through to "active". Empirically this is exactly how
  // dead/SPA sites (lefournil, thenestreno) became live-but-broken demos.
  if (siteChunks === 0) {
    throw new Error(`No SITE chunks for ${tenantId} from ${siteUrl} - dead, JS-only, or blocking the crawler; refusing to register (Google Maps data alone is not a valid site demo).`);
  }

  // --- Dedup for Vectorize: deterministic IDs + orphan cleanup ---
  // Vectorize has no delete-by-filter, so we track each tenant's chunk IDs in R2.
  // Unchanged chunks keep their ID (overwritten on upsert); removed/changed chunks
  // become orphans we delete. CRITICAL ORDERING: we always UPSERT FIRST, then delete
  // (orphans for tracked tenants, residue for untracked) — and we never delete an ID
  // that's in the current set. Deletes are async; the old code drained untracked
  // tenants BEFORE re-embedding, so an in-flight delete of a deterministic ID could
  // eat the same-ID re-insert (large tenants landed 0 queryable). Load prevIds here;
  // do all deletion AFTER the upsert+verify below.
  const newIds = context.chunks.map((c) => c.id);
  let prevIds: string[] | null = null;
  if (useVectorize) {
    const buf = await downloadFromR2(`tenants/${tenantId}/vector-ids.json`);
    if (buf) { try { prevIds = JSON.parse(buf.toString()); } catch {} }
  }

  // Embed into the vector store
  const embedResult = await embedChunks(context.chunks, provider, store);
  console.log(`[scrape-pipeline] ${embedResult.embeddedChunks} chunks embedded`);

  // Treat a meaningful embed shortfall as fatal. embedChunks already retries each
  // batch 3x, so failures here are persistent — a demo missing a chunk or two is
  // fine, but one missing 10%+ of its content must never be emailed as ready
  // (the old `< min(3,N)` gate let a 200-chunk site pass with only 3 embedded).
  const embedTolerance = Math.floor(context.chunks.length * 0.1);
  if (embedResult.failedChunks > embedTolerance) {
    throw new Error(`Embedding incomplete for ${tenantId}: ${embedResult.embeddedChunks}/${embedResult.totalChunks} embedded, ${embedResult.failedChunks} failed (tolerance ${embedTolerance}) — refusing to register a partial demo.`);
  }

  // POST-EMBED VERIFICATION — confirm vectors are actually queryable. The real
  // guarantee against silent failure lives in upsert(): it throws on ANY non-2xx
  // /insert (token invalid / HTTP error), so reaching here means the insert
  // HTTP-SUCCEEDED. This poll only confirms the index has caught up. Vectorize INSERT
  // is eventually consistent and routinely lags past a minute under load — empirically,
  // every tenant that "failed" a 42s poll had its vectors queryable minutes later. So
  // we poll generously but DO NOT throw on timeout: throwing strands a genuinely-
  // successful scrape AND skips the downstream context-meta.json write + R2 upload
  // (both below), manufacturing a vectors-but-no-context broken demo — the exact
  // opposite of the intent. Warn and proceed; the vectors land shortly.
  if (useVectorize && context.chunks.length > 0) {
    const vstore = store as CloudflareVectorizeStore;
    let queryable = false;
    const maxAttempts = 12; // ~100s total: 2,4,6,8,10,12,12,12,12,12,12s backoff
    for (let attempt = 1; attempt <= maxAttempts && !queryable; attempt++) {
      try {
        if (await vstore.hasVectors()) { queryable = true; break; }
      } catch (e) {
        console.log(`[scrape-pipeline] vector probe error (attempt ${attempt}): ${(e as Error).message}`);
      }
      if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, Math.min(attempt * 2000, 12000)));
    }
    if (queryable) {
      console.log(`[scrape-pipeline] verified ${tenantId}: vectors queryable in Vectorize`);
    } else {
      console.log(`[scrape-pipeline] WARNING ${tenantId}: ${context.chunks.length} chunks embedded, /insert HTTP-succeeded, but vectors not queryable after ~100s — Vectorize eventual-consistency lag. Proceeding (vectors land shortly); NOT failing the scrape.`);
    }
  }

  // Delete orphaned vectors (tracked before, absent now) and persist the current
  // ID set for the next re-scrape.
  if (useVectorize) {
    let idsToTrack = newIds;
    const newSet = new Set(newIds);
    if (prevIds) {
      const orphans = prevIds.filter((id) => !newSet.has(id));
      if (orphans.length > 0) {
        try {
          await store.delete(orphans);
          console.log(`[scrape-pipeline] Deleted ${orphans.length} orphaned vectors for ${tenantId}`);
        } catch (e) {
          // Orphan cleanup failed (delete() now throws on HTTP error). Don't fail the
          // scrape — the new vectors are embedded + verified. Persist the UNION so the
          // stale ids stay tracked and get re-cleaned on the next scrape.
          console.error(`[scrape-pipeline] orphan delete failed for ${tenantId}, keeping union for retry: ${(e as Error).message}`);
          idsToTrack = [...new Set([...prevIds, ...newIds])];
        }
      }
    } else {
      // Untracked tenant: the new chunks are already upserted (in place — same
      // deterministic IDs overwrite any prior copy, so there's no gap). Now clear
      // any LEGACY residue (old random-ID vectors from the pre-deterministic era)
      // WITHOUT touching the IDs we just inserted. This replaces the old pre-embed
      // deleteAll() that raced the re-insert. deleteAll(keepIds) never deletes a
      // kept ID, so the current vectors are safe regardless of async-delete timing.
      // (For a brand-new tenant the index is empty, so this resolves in one quick
      // round.) Non-fatal: residue gets re-cleaned on the next, now-tracked scrape.
      try {
        const removed = await (store as CloudflareVectorizeStore).deleteAll(newSet);
        if (removed > 0) console.log(`[scrape-pipeline] Cleared ${removed} legacy residue vectors for ${tenantId} (kept ${newSet.size} current)`);
      } catch (e) {
        console.error(`[scrape-pipeline] residue cleanup failed for ${tenantId} (current vectors unaffected): ${(e as Error).message}`);
      }
    }
    await uploadToR2(`tenants/${tenantId}/vector-ids.json`, JSON.stringify(idsToTrack), "application/json");
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
    // Canonical primary facts (always loaded + injected; see OfficialBusinessInfo).
    officialInfo: context.businessProfile || null,
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
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 2 });
      await page.goto(siteUrl, { waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(3000);

      const screenshotDir = resolve(DATA_ROOT, tenantId);
      if (!existsSync(screenshotDir)) mkdirSync(screenshotDir, { recursive: true });
      await page.screenshot({
        path: screenshotPath,
        fullPage: false,
        type: "png",
      });
      console.log(`[scrape-pipeline] Screenshot saved for ${tenantId}`);
      await browser.close();
    } catch (err) {
      console.log(`[scrape-pipeline] Screenshot skipped: ${(err as Error).message}`);
    }
  } else {
    console.log(`[scrape-pipeline] Screenshot already exists for ${tenantId}, skipping`);
  }

  // Mirror the on-disk artifacts to R2 so a demo survives a Render disk reset.
  // Render-worker scrapes (self-serve onboarding) previously left context-meta /
  // business-info / screenshot ONLY on local disk — chat worked until the next
  // redeploy wiped it, then broke silently with no R2 fallback (exactly how
  // bistro-burger_fr ended up vectors-but-no-R2). vector-ids.json is uploaded
  // above; sync the rest here for EVERY scrape so the manual pushR2 in the VPS
  // re-scrape scripts is no longer load-bearing.
  if (useVectorize) {
    const artifacts: [string, string][] = [
      ["context-meta.json", "application/json"],
      ["business-info.json", "application/json"],
      ["auto-context-notes.json", "application/json"],
      ["screenshot.png", "image/png"],
    ];
    for (const [file, ct] of artifacts) {
      const p = resolve(tenantDir, file);
      if (!existsSync(p)) continue;
      try {
        await uploadToR2(`tenants/${tenantId}/${file}`, await readFile(p), ct);
      } catch (e) {
        console.error(`[scrape-pipeline] R2 sync failed for ${tenantId}/${file}: ${(e as Error).message}`);
      }
    }
    console.log(`[scrape-pipeline] Synced on-disk artifacts to R2 for ${tenantId}`);
  }

  return {
    pages: pagesScraped,
    chunks: embedResult.embeddedChunks,
  };
}
