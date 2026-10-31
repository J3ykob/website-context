/**
 * One-off builds of businesses' quoting models (src/pricing/model.ts) on THIS machine with Claude Code
 * (Opus, the owner's own subscription - the CLI, never its token in our servers). Reads each business's offer
 * pages kept by its last scrape from R2, builds, verifies, saves tenants/<id>/pricing.json.
 *
 *   npx tsx scripts/pricing-build-local.ts sosnowydwor_com_pl aniatkaczyk_pl ...   (needs R2 + Jev env)
 *   env: CLAUDE_BIN (default ~/.local/bin/claude - the real binary, so no account switching), PRICING_MAX_PARTS
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { buildBusiness, savePricing, catalogOf, type Llm } from "../src/pricing/model.js";

const BIN = process.env.CLAUDE_BIN || `${homedir()}/.local/bin/claude`;
const claude = (model: string): Llm => (system, user) => new Promise((ok, fail) => {
  const p = spawn(BIN, ["-p", "--model", model, "--system-prompt", system, "--tools", "", "--output-format", "text"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => (code === 0 ? ok(out) : fail(new Error(`claude exited ${code}: ${err.slice(0, 200)}`))));
  p.stdin.end(user);
});

const ids = process.argv.slice(2);
if (!ids.length) { console.error("Give tenant ids."); process.exit(1); }
const { hydrateRegistry, getTenant } = await import("../src/multi-tenant/d1-registry.js");
await hydrateRegistry();
const { downloadFromR2 } = await import("../src/storage/r2.js");
const { loadOffer } = await import("../src/offer/store.js");
for (const id of ids) {
  const t0 = Date.now();
  const pages: { url: string; text: string }[] = await downloadFromR2(`tenants/${id}/offer-pages.json`).then((b) => (b ? JSON.parse(b.toString("utf-8")) : [])).catch(() => []);
  if (!pages.length) { console.log(`${id}: no offer pages kept - re-scrape it first`); continue; }
  const t = getTenant(id);
  const offer = (await loadOffer(id).catch(() => null))?.items || [];
  try {
    const pb = await buildBusiness(id, t?.brandName || t?.domain || id, pages, offer.map((i) => i.name), "claude-code:opus", { gen: claude("opus"), check: claude("sonnet") });
    if (pb.parts.length) await savePricing(pb);
    console.log(`${id}: ${pb.parts.length} part(s), ${catalogOf(pb).items.length} items, checks ${pb.parts.reduce((n, p) => n + (p.verified?.agreed || 0), 0)}/${pb.parts.reduce((n, p) => n + (p.verified?.cases || 0), 0)}, missing ${pb.missing.length}, ${((Date.now() - t0) / 60000).toFixed(1)} min, from ${pages.length} pages`);
  } catch (e) { console.log(`${id}: failed - ${(e as Error).message}`); }
}
