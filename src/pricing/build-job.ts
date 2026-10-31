/**
 * Builds and stores a business's quoting model (model.ts) from the offer pages its last scrape kept
 * (tenants/<id>/offer-pages.json). Skipped when the stored model was built from the same pages (hash).
 */
import { createHash } from "node:crypto";
import { buildBusiness, loadPricing, savePricing, type PricingBusiness } from "./model.js";

const running = new Set<string>();

export async function buildPricingFor(tenantId: string, opts: { force?: boolean } = {}): Promise<PricingBusiness | { skipped: string }> {
  if (running.has(tenantId)) return { skipped: "already building" };
  running.add(tenantId);
  try {
    const { downloadFromR2 } = await import("../storage/r2.js");
    const pages: { url: string; text: string }[] = await downloadFromR2(`tenants/${tenantId}/offer-pages.json`).then((b) => (b ? JSON.parse(b.toString("utf-8")) : [])).catch(() => []);
    if (!pages.length) return { skipped: "no offer pages kept - re-scrape the business first" };
    const model = process.env.PRICING_MODEL || "anthropic/claude-opus-5.5";
    const hash = createHash("sha1").update(`${model}\n${pages.map((p) => `${p.url}\n${p.text}`).join("\n")}`).digest("hex");
    const prev = await loadPricing(tenantId);
    if (!opts.force && prev?.hash === hash) return { skipped: "pages unchanged since the last build" };
    const { loadOffer } = await import("../offer/store.js");
    const { getTenant } = await import("../multi-tenant/d1-registry.js");
    const t = getTenant(tenantId);
    const offer = (await loadOffer(tenantId).catch(() => null))?.items || [];
    const pb = await buildBusiness(tenantId, t?.brandName || t?.domain || tenantId, pages, offer.map((i) => i.name), model);
    if (pb.parts.length) await savePricing(pb);
    return pb;
  } finally {
    running.delete(tenantId);
  }
}
