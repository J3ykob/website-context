/**
 * Builds and stores a business's quoting model (model.ts) from the offer pages its last scrape kept
 * (tenants/<id>/offer-pages.json). Skipped when the stored model was built from the same pages (hash).
 */
import { buildBusiness, loadPricing, savePricing, pagesHash, type PricingBusiness } from "./model.js";

const running = new Set<string>();

/**
 * The business's general terms that the offer pages leave out: the passages of its "policies" topic (the knowledge
 * catalogue) that Jev reads as conditions of every order - delivery, payment, deposits, discounts, minimums. One page
 * each, the chosen passages only (a shop's terms are mostly complaints and personal data: 19,000 characters in every
 * part). Sweet Home's delivery fee (19,5 zł) stands only in its terms, which is no offer page: its quoting program
 * priced delivery "on request" (2026-11-23).
 */
export async function termsPages(tenantId: string): Promise<{ url: string; text: string }[]> {
  const { downloadFromR2 } = await import("../storage/r2.js");
  const cat: { chunks?: { catalogId: string; content: string; url?: string }[] } | null = await downloadFromR2(`tenants/${tenantId}/knowledge-catalog.json`).then((b) => (b ? JSON.parse(b.toString("utf-8")) : null)).catch(() => null);
  const chunks = (cat?.chunks || []).filter((c) => c.catalogId === "policies" && c.url);
  if (!chunks.length) return [];
  const { jevAsk } = await import("../llm/jev.js");
  const { siteText } = await import("../llm/packs.js");
  const a = await jevAsk({ passages: chunks.map((c) => siteText(c.content).slice(0, 8000)) }, Object.fromEntries(chunks.map((_, k) => [`t${k}`, { type: "noul" as const, instructions: `Does \`passages[${k}]\` state conditions that apply to every order from the business and bear on what the customer pays or how they order: delivery or travel charges, payment, deposits, discounts, minimums, order deadlines?` }])), 20000).catch(() => null);
  const pages = new Map<string, string[]>();
  chunks.forEach((c, k) => { if ((((a as any)?.[`t${k}`]?.noul as number) ?? 0) >= 0.5) pages.set(c.url!, [...(pages.get(c.url!) || []), siteText(c.content)]); });
  return [...pages].map(([url, texts]) => ({ url, text: texts.join("\n\n") }));
}

export async function buildPricingFor(tenantId: string, opts: { force?: boolean } = {}): Promise<PricingBusiness | { skipped: string }> {
  if (running.has(tenantId)) return { skipped: "already building" };
  running.add(tenantId);
  try {
    const { downloadFromR2 } = await import("../storage/r2.js");
    const pages: { url: string; text: string }[] = await downloadFromR2(`tenants/${tenantId}/offer-pages.json`).then((b) => (b ? JSON.parse(b.toString("utf-8")) : [])).catch(() => []);
    if (!pages.length) return { skipped: "no offer pages kept - re-scrape the business first" };
    const model = process.env.PRICING_MODEL || "anthropic/claude-opus-5.5";
    const hash = pagesHash(model, pages);
    const prev = await loadPricing(tenantId);
    if (!opts.force && prev?.hash === hash) return { skipped: "pages unchanged since the last build" };
    const { loadOffer } = await import("../offer/store.js");
    const { getTenant } = await import("../multi-tenant/d1-registry.js");
    const t = getTenant(tenantId);
    const offer = (await loadOffer(tenantId).catch(() => null))?.items || [];
    const pb = await buildBusiness(tenantId, t?.brandName || t?.domain || tenantId, pages, offer.map((i) => i.name), model, undefined, await termsPages(tenantId));
    if (pb.parts.length) await savePricing(pb);
    return pb;
  } finally {
    running.delete(tenantId);
  }
}
