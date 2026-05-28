/**
 * Backfill existing sent data into D1 analytics.
 * Reads pipeline-sent.json and inserts into prospects table.
 */

import { recordProspect } from "../src/analytics/d1.js";
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const sentLog = JSON.parse(readFileSync(resolve(__dirname, "../data/pipeline-sent.json"), "utf-8"));
  const entries = Object.entries(sentLog) as [string, { sentAt: string; template: string }][];

  console.log(`Backfilling ${entries.length} prospects to D1...`);
  let ok = 0;

  for (const [email, data] of entries) {
    if (data.template === "skip-broken" || data.template === "skip-hung" || data.template === "skip") continue;
    const domain = email.split("@")[1] || "unknown";
    const tenantId = domain.replace(/[^a-zA-Z0-9]/g, "_");

    await recordProspect({
      email,
      firstName: "",
      domain,
      orgName: "",
      title: "",
      country: "unknown",
      industry: "unknown",
      lang: domain.endsWith(".pl") ? "pl" : "en",
      template: data.template,
      tenantId,
      sentAt: data.sentAt,
      scrapePages: 0,
      scrapeChunks: 0,
      screenshot: false,
    });
    ok++;
    if (ok % 50 === 0) console.log(`${ok}/${entries.length}`);
  }

  console.log(`DONE: ${ok} backfilled`);
}

main().catch(console.error);
