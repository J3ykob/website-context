/**
 * Backfill the canonical Official Business Info profile onto EXISTING tenants without a
 * full re-scrape or any LLM/embedding cost. Fetches just the homepage + contact page(s),
 * runs the same extractOfficialInfo() the scrape pipeline uses, patches `officialInfo` into
 * the tenant's context-meta.json, uploads it back to R2 (the server's source of truth), and
 * (if ADMIN_SECRET is set) pushes it to the live server + evicts the cache for instant pickup.
 *
 * Usage:
 *   node --import tsx scripts/backfill-business-info.ts <tenantId> [<tenantId> ...]
 *   node --import tsx scripts/backfill-business-info.ts --dry <tenantId>   # print profile, don't write
 *
 * Cost: ~2-4 HTTP fetches per tenant. Zero tokens. Vectors/chunks untouched.
 */
import { downloadTenantFile, uploadToR2 } from "../src/storage/r2.js";
import { fetchPage } from "../src/scraper/fetcher.js";
import { extractOfficialInfo } from "../src/context/business-profile.js";

const CONTACT_RE = /kontakt|contact|impressum|o-nas|contacto|contatti|kontakt-oss|contact-us|nous-contacter/i;
const SERVE_URL = process.env.SERVE_URL || "https://whisp.so";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";

async function backfillOne(tenantId: string, dry: boolean): Promise<void> {
  const buf = await downloadTenantFile(tenantId, "context-meta.json");
  if (!buf) { console.log(`[${tenantId}] SKIP — no context-meta.json in R2`); return; }
  let meta: any;
  try { meta = JSON.parse(buf.toString("utf-8")); } catch (e: any) { console.log(`[${tenantId}] SKIP — bad meta JSON: ${e.message}`); return; }

  const siteUrl: string = meta.siteUrl;
  if (!siteUrl) { console.log(`[${tenantId}] SKIP — no siteUrl`); return; }

  // Pick pages: homepage first, then up to 3 contact-ish pages already known from the crawl.
  const urls: string[] = [siteUrl];
  for (const p of (meta.pages || [])) {
    if (urls.length >= 4) break;
    if (typeof p?.url === "string" && CONTACT_RE.test(p.url) && !urls.includes(p.url)) urls.push(p.url);
  }

  const pages: { url: string; html: string }[] = [];
  for (const u of urls) {
    try {
      const r = await fetchPage(u, { timeout: 15000 });
      if (r?.html && r.html.length > 300) pages.push({ url: u, html: r.html });
    } catch { /* skip unreachable page */ }
  }
  if (!pages.length) { console.log(`[${tenantId}] SKIP — could not fetch any page`); return; }

  const info = extractOfficialInfo(pages, siteUrl);
  console.log(`[${tenantId}] ${pages.length} pages | phone=${info.primaryPhone?.value || "(absent)"} [${info.primaryPhone?.source || "-"}] email=${info.primaryEmail?.value || "(absent)"} addr=${info.primaryAddress ? "Y" : "-"} hours=${info.openingHours ? "Y" : "-"} alts=${(info.alternatePhones || []).length} | ${info.extractionBasis}`);
  if (dry) return;

  meta.officialInfo = info;
  meta.officialInfoAt = info.extractedAt;
  const json = JSON.stringify(meta, null, 2);

  const ok = await uploadToR2(`tenants/${tenantId}/context-meta.json`, json, "application/json");
  if (!ok) { console.log(`[${tenantId}] ERROR — R2 upload failed`); return; }

  // Push to the live server's local cache + evict, so it serves the new profile immediately.
  // Bounded timeout: during a Render deploy the server may be mid-cutover, and an
  // unbounded fetch would hang the whole sequential backfill (it did, once).
  if (ADMIN_SECRET) {
    try {
      // octet-stream, NOT application/json: the endpoint reads the raw req stream via
      // req.on("data"/"end"), but express.json() would consume an application/json body
      // first, leaving those events to never fire -> the handler hangs until our timeout.
      const resp = await fetch(`${SERVE_URL}/api/admin/upload-file/${tenantId}/context-meta.json?secret=${encodeURIComponent(ADMIN_SECRET)}`, {
        method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: json,
        signal: AbortSignal.timeout(12000),
      });
      console.log(`[${tenantId}] R2 OK; server push ${resp.status === 200 ? "OK (evicted)" : "FAILED " + resp.status}`);
    } catch (e: any) {
      console.log(`[${tenantId}] R2 OK; server push error: ${e.message} (will pick up on next cold load / eviction)`);
    }
  } else {
    console.log(`[${tenantId}] R2 OK (no ADMIN_SECRET — server picks up on next cold load / 5-min eviction)`);
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const tenants = args.filter((a) => a !== "--dry");
  if (!tenants.length) { console.error("usage: backfill-business-info.ts [--dry] <tenantId> [<tenantId> ...]"); process.exit(1); }
  for (const t of tenants) {
    try { await backfillOne(t, dry); } catch (e: any) { console.log(`[${t}] ERROR: ${e.message}`); }
  }
}
main();
