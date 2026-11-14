/**
 * A site's pages read somewhere else and brought to the server as a file (2026-11-14: a cake shop's host
 * refused the server's address for a day, while the site answered everyone else - the bot stayed on a
 * wrong price list). The crawl runs on another machine and writes each page as it is read
 * (scripts/crawl-to-file.ts); the server takes the file in place of its own crawl and does everything
 * else as usual (text, knowledge, price list, vectors).
 *
 * One page per line (JSON, with the fetched HTML), gzipped. The file lives in the system's temporary
 * folder: a restart drops it, so pages brought in once are never mistaken for a fresh crawl later.
 */
import { createReadStream, createWriteStream, existsSync } from "fs";
import { rm } from "fs/promises";
import { tmpdir } from "os";
import { resolve } from "path";
import { createInterface } from "readline";
import { createGunzip, createGzip } from "zlib";
import { once } from "events";
import type { CrawlResult, ScrapedPage } from "./types.js";

/** Where a tenant's brought-in pages wait for its scrape (the id is already a safe folder name). */
export function crawlFilePath(tenantId: string): string {
  return resolve(tmpdir(), `whisp-crawl-${tenantId}.jsonl.gz`);
}
export const hasCrawlFile = (tenantId: string): boolean => existsSync(crawlFilePath(tenantId));
export const dropCrawlFile = (tenantId: string): Promise<void> => rm(crawlFilePath(tenantId), { force: true });

/** Writes pages to a file as a crawl delivers them (crawlSite's onPage). */
export function crawlFileWriter(path: string): { onPage: (page: ScrapedPage) => Promise<void>; close: () => Promise<number> } {
  const gz = createGzip();
  const out = createWriteStream(path);
  gz.pipe(out);
  let n = 0;
  return {
    onPage: async (page) => { n++; if (!gz.write(JSON.stringify(page) + "\n")) await once(gz, "drain"); },
    close: async () => { gz.end(); await once(out, "finish"); return n; },
  };
}

/**
 * The pages of a file, handed to `onPage` one at a time as a crawl would (memory stays flat: a page's HTML
 * is dropped once its consumer is done with it). Returns what a crawl returns.
 */
export async function replayCrawlFile(path: string, startUrl: string, onPage: (page: ScrapedPage) => Promise<void> | void): Promise<CrawlResult> {
  const t0 = Date.now();
  const pages: ScrapedPage[] = [];
  let failed = 0, staticPages = 0, dynamicPages = 0;
  const lines = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line) continue;
    let page: ScrapedPage;
    try { page = JSON.parse(line) as ScrapedPage; } catch { failed++; continue; }
    if (!page?.url) { failed++; continue; }
    if (page.renderMethod === "dynamic") dynamicPages++; else staticPages++;
    try { await onPage(page); } catch (e) { console.warn(`  [onPage] ${page.url}: ${(e as Error).message}`); }
    page.fetch = undefined; page.content = []; page.links = []; page.forms = []; page.structuredData = [];
    pages.push(page);
  }
  return {
    baseUrl: startUrl,
    pages,
    siteMap: { url: startUrl, title: pages[0]?.title || "", children: [], depth: 0 },
    crawledAt: new Date().toISOString(),
    stats: { totalPages: pages.length + failed, successPages: pages.length, failedPages: failed, totalTime: Date.now() - t0, staticPages, dynamicPages },
  };
}
