/**
 * One-off builds of businesses' quoting models (src/pricing/model.ts) on THIS machine with Claude Code
 * (Opus, the owner's own subscription - the CLI, never its token in our servers). Reads each business's offer
 * pages kept by its last scrape from R2, builds, verifies, saves tenants/<id>/pricing.json.
 *
 *   npx tsx scripts/pricing-build-local.ts sosnowydwor_com_pl aniatkaczyk_pl ...   (needs R2 + Jev env)
 *   env: CLAUDE_BIN (default ~/.local/bin/claude - the real binary, so no account switching), PRICING_MAX_PARTS,
 *        PRICING_CALL_MIN (10), PRICING_PARTS_AT_ONCE (4). Parts a stored model already has from the same page text are kept.
 */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { buildBusiness, savePricing, loadPricing, catalogOf, type Llm } from "../src/pricing/model.js";
import { termsPages } from "../src/pricing/build-job.js";

const BIN = process.env.CLAUDE_BIN || `${homedir()}/.local/bin/claude`;
// A call that hangs (2026-11-16: four calls sat 9-12 h with no output) is killed after CALL_MIN and asked again.
// 45 min at first; calls that answer take 2-6 min, and 12 hung ones cost 9 of a build's 13.4 hours (2026-11-24).
const CALL_MIN = Number(process.env.PRICING_CALL_MIN) || 10;
// Parts built at once (each call is its own CLI process).
const AT_ONCE = Number(process.env.PRICING_PARTS_AT_ONCE) || 4;
const once = (model: string, system: string, user: string) => new Promise<string>((ok, fail) => {
  const p = spawn(BIN, ["-p", "--model", model, "--system-prompt", system, "--tools", "", "--output-format", "text"], { stdio: ["pipe", "pipe", "pipe"] });
  let out = "", err = "";
  const timer = setTimeout(() => { err = `no answer in ${CALL_MIN} min`; p.kill("SIGKILL"); }, CALL_MIN * 60_000);
  p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
  p.on("close", (code) => { clearTimeout(timer); code === 0 ? ok(out) : fail(new Error(`claude exited ${code}: ${err.slice(0, 200)}`)); });
  p.stdin.end(user);
});
const claude = (model: string): Llm => async (system, user) => {
  for (let k = 1; ; k++) {
    try { return await once(model, system, user); }
    catch (e) { console.log(`[claude] ${model} call ${k} failed: ${(e as Error).message}`); if (k >= 3) throw e; }
  }
};

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
  const terms = await termsPages(id);
  console.log(`${id}: ${pages.length} offer pages, general terms from ${terms.length} page(s) (${terms.reduce((n, p) => n + p.text.length, 0)} chars)`);
  try {
    const pb = await buildBusiness(id, t?.brandName || t?.domain || id, pages, offer.map((i) => i.name), "claude-code:opus", { gen: claude("opus"), check: claude("sonnet") }, terms, {
      concurrency: AT_ONCE, prev: await loadPricing(id),
      onPart: (k, of, how) => console.log(`${id}: part ${k + 1}/${of} ${how} (${((Date.now() - t0) / 60000).toFixed(1)} min)`),
    });
    // Stored straight to the storage; when this machine's upload fails (large uploads stalled on its network,
    // 2026-11-24), through the server (PUT /api/admin/pricing/<id>; needs ADMIN_SECRET).
    if (pb.parts.length) await savePricing(pb).catch(async (e) => {
      if (!process.env.ADMIN_SECRET) throw e;
      const r = await fetch(`${process.env.WHISP_BASE || "https://whisp.so"}/api/admin/pricing/${id}`, { method: "PUT", headers: { "x-admin-secret": process.env.ADMIN_SECRET, "Content-Type": "application/octet-stream" }, body: JSON.stringify(pb) });
      if (!r.ok) throw new Error(`${(e as Error).message}; through the server: HTTP ${r.status} ${(await r.text()).slice(0, 120)}`);
      console.log(`${id}: stored through the server`);
    });
    console.log(`${id}: ${pb.parts.length} part(s), ${catalogOf(pb).items.length} items, checks ${pb.parts.reduce((n, p) => n + (p.verified?.agreed || 0), 0)}/${pb.parts.reduce((n, p) => n + (p.verified?.cases || 0), 0)}, missing ${pb.missing.length}, ${((Date.now() - t0) / 60000).toFixed(1)} min, from ${pages.length} pages${pb.failed?.length ? `, ${pb.failed.length} part(s) FAILED: ${pb.failed[0]}` : ""}`);
  } catch (e) { console.log(`${id}: failed - ${(e as Error).message}`); }
}
