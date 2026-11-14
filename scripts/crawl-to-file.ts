/**
 * Reads a site's pages on THIS machine and hands them to the server, for a site whose host refuses the
 * server's address (src/scraper/page-file.ts). Same crawler, same pace (2 requests a second), same page
 * judging as a server scrape; the server then builds the bot from the pages.
 *
 *   npx tsx scripts/crawl-to-file.ts <tenantId> [siteUrl]      (needs ADMIN_SECRET; JEV_API_KEY for page judging)
 *   ... --keep   keeps the file and does not send it (to look at a crawl first)
 */
import { rm, stat } from "fs/promises";
import { createReadStream } from "fs";
import { tmpdir } from "os";
import { resolve } from "path";
import { crawlSite } from "../src/scraper/crawler.js";
import { makeTriage } from "../src/scraper/triage.js";
import { crawlFileWriter } from "../src/scraper/page-file.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const keep = process.argv.includes("--keep");
const tenantId = args[0];
const BASE = process.env.WHISP_API || "https://whisp.so";
const SECRET = process.env.ADMIN_SECRET || "";
if (!tenantId || !SECRET) { console.error("Usage: ADMIN_SECRET=... npx tsx scripts/crawl-to-file.ts <tenantId> [siteUrl] [--keep]"); process.exit(1); }

const tenant = await (await fetch(`${BASE}/api/health/${encodeURIComponent(tenantId)}`)).json() as { domain?: string };
const siteUrl = args[1] || (tenant.domain ? `https://${tenant.domain}` : "");
if (!siteUrl) { console.error(`No site address for ${tenantId} - pass it as the second argument`); process.exit(1); }

const file = resolve(tmpdir(), `whisp-crawl-${tenantId}.jsonl.gz`);
const writer = crawlFileWriter(file);
const result = await crawlSite(siteUrl, {
  maxDepth: 10, rateLimit: 100, minGap: Number(process.env.SCRAPE_MIN_GAP_MS) || 500, concurrency: Number(process.env.SCRAPE_CONCURRENCY) || 12,
  maxTime: (Number(process.env.SCRAPE_CRAWL_MIN) || 45) * 60 * 1000, triage: makeTriage(""), onPage: writer.onPage,
});
const written = await writer.close();
const size = (await stat(file)).size;
console.log(`\n${written} pages read (${result.stats.failedPages} failed${result.stats.leftUnread ? `, ${result.stats.leftUnread} left unread - stopped by ${result.stats.stoppedBy}` : ""}), file ${(size / 1e6).toFixed(1)} MB: ${file}`);
if (!written) { await rm(file, { force: true }); console.error("Nothing read - nothing sent."); process.exit(1); }
if (keep) process.exit(0);

const res = await fetch(`${BASE}/api/admin/crawl-file/${encodeURIComponent(tenantId)}`, {
  method: "POST",
  headers: { "x-admin-secret": SECRET, "content-type": "application/octet-stream", "content-length": String(size) },
  body: createReadStream(file) as any,
  duplex: "half",
} as RequestInit);
console.log(`server: ${res.status} ${await res.text()}`);
await rm(file, { force: true });
process.exit(res.ok ? 0 : 1);
