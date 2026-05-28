import { scrapeTenant } from "../src/multi-tenant/scrape-pipeline.js";
import { closeBrowser } from "../src/scraper/index.js";
import { uploadTenantFiles } from "../src/storage/r2.js";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const domain = process.argv[2];
if (!domain) { console.log("Usage: npx tsx scripts/rescrape-one.ts <domain>"); process.exit(1); }
const tid = domain.replace(/[^a-zA-Z0-9]/g, "_");

async function main() {
  console.log(`Scraping ${domain} (${tid})...`);
  const r = await scrapeTenant(tid, `https://${domain}`, 20);
  await closeBrowser();
  console.log(`${r.pages}p ${r.chunks}c`);
  const u = await uploadTenantFiles(tid, resolve(__dirname, "../data"));
  console.log(`R2: ${u} files`);
  await fetch(`https://whisp.so/api/admin/update-tenant/${tid}?secret=whisp-admin-2026`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status: "active", chunksCount: r.chunks, pagesCount: r.pages, domain, siteUrl: `https://${domain}` }),
  });
  console.log("Done");
}
main().catch(e => console.log("ERR: " + e.message));
