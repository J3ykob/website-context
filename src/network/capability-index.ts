/**
 * The network's capability index (2026-10-29): what every business offers, in ONE shared Vectorize index
 * (whisp-network-m3), so finding the businesses for a need costs the same at 16 members or 10,000.
 *
 * Before: the chat queried every member's own vectors (one query per business, member list cut at 40)
 * and the agent judged every member's offer with Jev (~2 calls per business: 31 for 16, ~340 for the
 * 168-firm Warsaw base). Now: one query in the network (metadata filter `ecosystem`), the 100 nearest
 * records grouped by business, the best few go on to the existing judging - on those few only.
 *
 * Records per business (rebuilt at every scrape and on demand): its profile (site card), its services
 * (site-card sections), its offer items - one record per item, or per category with example names when
 * the offer is large (a 2,347-product shop must not fill the top 100 on its own). Metadata: tenant,
 * ecosystem, region (voivodeship from the address's postal code), kind, text.
 */
import { createHash } from "crypto";
import { getCfToken, refreshCfToken } from "../storage/cf-auth.js";

const ACCOUNT = "98e447c9e14d384e1b7e6f4d42c39ad2";
const INDEX = () => process.env.NETWORK_INDEX || "whisp-network-m3";
const base = () => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/vectorize/v2/indexes/${INDEX()}`;
const MAX_RECORDS = 150;      // per business: a big catalogue is summarised by category beyond this
const ITEM_LIMIT = 80;        // up to this many offer items get a record of their own (the rest of the budget is page content)
const CATEGORY_LIMIT = 60;    // a larger offer: at most this many category records
const QUERY_TOP = 100;        // nearest records per search (Vectorize max with indexed metadata only)

export interface CapabilityRecord { id: string; tenant: string; kind: "profile" | "service" | "item" | "category"; text: string }

async function cf(path: string, init: RequestInit): Promise<any> {
  const go = () => fetch(`${base()}${path}`, { ...init, headers: { Authorization: `Bearer ${getCfToken()}`, ...(init.headers || {}) } });
  let r = await go();
  if (r.status === 401 || r.status === 403) { await refreshCfToken(); r = await go(); }
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || j?.success === false) throw new Error(`network index ${path}: HTTP ${r.status} ${JSON.stringify(j?.errors || "").slice(0, 200)}`);
  return j.result;
}

async function embed(texts: string[]): Promise<number[][]> {
  const { BGEEmbeddingProvider } = await import("../embeddings/bge-provider.js");
  return new BGEEmbeddingProvider({ model: "bge-m3", batchSize: 96 }).embed(texts);
}

const recId = (tenant: string, k: number) => `${createHash("md5").update(tenant).digest("hex").slice(0, 20)}:${k}`;

/** Voivodeship from a Polish postal code (first two digits); "" when unknown. */
export function regionOf(address: string): string {
  const m = String(address || "").match(/\b(\d{2})-\d{3}\b/);
  if (!m) return "";
  const n = Number(m[1]);
  const table: [number, number, string][] = [[0, 9, "mazowieckie"], [10, 14, "warminsko-mazurskie"], [15, 19, "podlaskie"], [20, 24, "lubelskie"], [25, 29, "swietokrzyskie"], [30, 34, "malopolskie"], [35, 39, "podkarpackie"], [40, 44, "slaskie"], [45, 49, "opolskie"], [50, 59, "dolnoslaskie"], [60, 64, "wielkopolskie"], [65, 69, "lubuskie"], [70, 78, "zachodniopomorskie"], [80, 84, "pomorskie"], [85, 89, "kujawsko-pomorskie"], [90, 99, "lodzkie"]];
  return table.find(([a, b]) => n >= a && n <= b)?.[2] || "";
}

/** What a business offers, as short records (no model calls: its site card, offer and profile). */
export async function capabilityRecords(tenantId: string, ecosystemOverride?: string): Promise<{ records: CapabilityRecord[]; region: string; ecosystem: string } | null> {
  const { getTenant } = await import("../multi-tenant/d1-registry.js");
  const t = getTenant(tenantId);
  if (!t) return null;
  const ecosystem = ecosystemOverride ?? (typeof t.settings?.ecosystem === "string" ? t.settings.ecosystem.trim() : "");
  const card = t.settings?.siteCard || {};
  const label = card.brand || t.brandName || t.domain;
  const records: CapabilityRecord[] = [];
  const push = (kind: CapabilityRecord["kind"], text: string) => { const x = text.replace(/\s+/g, " ").trim(); if (x.length >= 8 && records.length < MAX_RECORDS) records.push({ id: recId(tenantId, records.length), tenant: tenantId, kind, text: x.slice(0, 900) }); };
  const { loadOffer } = await import("../offer/store.js");
  const items = (await loadOffer(tenantId).catch(() => null))?.items || [];
  if (items.length <= ITEM_LIMIT) {
    for (const i of items.slice(0, ITEM_LIMIT)) push("item", `${label}: ${i.name}${i.category ? ` (${i.category})` : ""}${i.description ? ` - ${i.description.slice(0, 160)}` : ""}`);
  } else {
    // A large offer: one record per category with example names, so it is found by any of its lines
    // without taking over the nearest 100.
    const byCat = new Map<string, string[]>();
    for (const i of items) { const c = i.category || "Inne"; const l = byCat.get(c) || []; if (l.length < 25) l.push(i.name); byCat.set(c, l); }
    for (const [c, names] of [...byCat.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, CATEGORY_LIMIT)) push("category", `${label}: ${c} - ${names.join("; ")}`);
  }
  // The site's own content (the owner's point, 2026-10-29: a site card is a model's summary of a few
  // sections - incomplete, possibly slanted): the knowledge chunks the bot answers from, each with its page
  // title and the keywords labelled from its own text. One per page first, then more, within the budget;
  // contact / locations / legal chunks say who the business is, not what it offers.
  try {
    const { loadKnowledgeCatalog } = await import("../multi-tenant/tenant-manager.js");
    const cat = await loadKnowledgeCatalog(tenantId);
    const SKIP = new Set(["contact", "locations", "legal", "privacy", "navigation"]);
    const chunks = (cat?.chunks || []).filter((c) => !SKIP.has(c.catalogId) && c.content.trim().length >= 40);
    const firstPerPage = new Map<string, typeof chunks[number]>();
    for (const c of chunks) if (!firstPerPage.has(c.url)) firstPerPage.set(c.url, c);
    const ordered = [...firstPerPage.values(), ...chunks.filter((c) => firstPerPage.get(c.url) !== c)];
    for (const c of ordered) {
      if (records.length >= MAX_RECORDS) break;
      const title = (c.title || "").replace(/\s*[-|–]\s*[^-|–]*$/, "").trim();
      push("service", `${label}: ${title ? `${title}. ` : ""}${c.content.replace(/\s+/g, " ").slice(0, 500)}`);
    }
  } catch {}
  // Last resort for a business without knowledge chunks: its site card.
  if (!records.length) {
    push("profile", [label, card.eyebrow, card.tagline].filter(Boolean).join(" - "));
    for (const s of (Array.isArray(card.sections) ? card.sections : []).slice(0, 12)) push("service", `${label}: ${s.label}. ${String(s.text || "").slice(0, 500)}`);
  }
  let region = "";
  try {
    const { downloadTenantFile } = await import("../storage/r2.js");
    const meta = JSON.parse((await downloadTenantFile(tenantId, "context-meta.json"))?.toString("utf-8") || "{}");
    region = regionOf(String(meta?.officialInfo?.primaryAddress?.value || ""));
    // Page titles: every scraped business has them, and they name what it offers ("Usługi elewacyjne
    // mazowieckie", product pages) - most businesses have no site card or offer list. Pages before
    // articles; contact, legal and blog-index pages left out.
    const GENERIC = /(kontakt|contact|regulamin|polityka|privacy|cookies|rodo|koszyk|cart|konto|account|logowanie|login|blog|aktualno|news)/i;
    const map = (Array.isArray(meta?.siteMap) ? meta.siteMap : []) as { title?: string; url?: string; type?: string }[];
    const seen = new Set<string>();
    for (const p of records.length >= 20 ? [] : [...map.filter((x) => x.type !== "article"), ...map.filter((x) => x.type === "article")]) {
      const title = String(p.title || "").replace(/\s*[-|–]\s*[^-|–]*$/, "").trim();
      if (title.length < 6 || GENERIC.test(`${title} ${p.url || ""}`) || seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      if (seen.size > 60) break;
      push("service", `${label}: ${title}`);
    }
  } catch {}
  return { records, region, ecosystem };
}

/** (Re)builds a business's records in the index; its previous records are removed first. */
export async function indexBusiness(tenantId: string, opts: { ecosystem?: string } = {}): Promise<number> {
  const built = await capabilityRecords(tenantId, opts.ecosystem);
  if (!built) return 0;
  const { downloadFromR2, uploadToR2 } = await import("../storage/r2.js");
  const listKey = `network-index/${INDEX()}/${tenantId}.json`;
  const prev: string[] = JSON.parse((await downloadFromR2(listKey).catch(() => null))?.toString("utf-8") || "[]");
  const now = new Set(built.records.map((r) => r.id));
  const stale = prev.filter((id) => !now.has(id));
  for (let k = 0; k < stale.length; k += 500) await cf("/delete_by_ids", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: stale.slice(k, k + 500) }) });
  if (!built.ecosystem || !built.records.length) { await uploadToR2(listKey, "[]", "application/json"); return 0; }
  const vecs = await embed(built.records.map((r) => r.text));
  const lines = built.records.map((r, k) => JSON.stringify({ id: r.id, values: vecs[k], metadata: { tenant: tenantId, ecosystem: built.ecosystem, region: built.region, kind: r.kind, text: r.text } }));
  for (let k = 0; k < lines.length; k += 500) await cf("/upsert", { method: "POST", headers: { "Content-Type": "application/x-ndjson" }, body: lines.slice(k, k + 500).join("\n") });
  await uploadToR2(listKey, JSON.stringify([...now]), "application/json");
  return built.records.length;
}

export interface NetworkCandidate { tenant: string; score: number; hits: number; lines: string[] }

/**
 * The businesses of a network whose records are nearest to the need: one query, grouped by business.
 * null = the index has nothing for this network yet (callers keep their old path).
 */
// The same need in the same network reuses its shortlist for an hour (NETWORK_SEARCH_CACHE_MIN).
const searchCache = new Map<string, { at: number; out: NetworkCandidate[] | null }>();

export async function searchNetwork(ecosystem: string, need: string, opts: { exclude?: string[]; limit?: number; region?: string; vector?: number[]; withLines?: boolean } = {}): Promise<NetworkCandidate[] | null> {
  if (!ecosystem || !need.trim()) return [];
  const cacheKey = JSON.stringify([ecosystem, need.trim().toLowerCase().slice(0, 2000), opts.exclude || [], opts.limit || 12, opts.region || "", !!opts.withLines]);
  const hit = searchCache.get(cacheKey);
  if (hit && Date.now() - hit.at < (Number(process.env.NETWORK_SEARCH_CACHE_MIN) || 60) * 60_000) return hit.out;
  const out = await searchNetworkUncached(ecosystem, need, opts);
  if (searchCache.size > 2000) searchCache.clear();
  searchCache.set(cacheKey, { at: Date.now(), out });
  return out;
}

async function searchNetworkUncached(ecosystem: string, need: string, opts: { exclude?: string[]; limit?: number; region?: string; vector?: number[]; withLines?: boolean }): Promise<NetworkCandidate[] | null> {
  const vector = opts.vector || (await embed([need.slice(0, 2000)]))[0];
  const filter: Record<string, unknown> = { ecosystem };
  if (opts.region) filter.region = opts.region;
  const res = await cf("/query", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vector, topK: QUERY_TOP, returnValues: false, returnMetadata: "indexed", filter }) });
  const matches: { id: string; score: number; metadata?: { tenant?: string } }[] = res?.matches || [];
  if (!matches.length) return null;
  const exclude = new Set(opts.exclude || []);
  const byTenant = new Map<string, { score: number; hits: number; ids: string[] }>();
  for (const m of matches) {
    const t = m.metadata?.tenant;
    if (!t || exclude.has(t)) continue;
    const e = byTenant.get(t) || { score: 0, hits: 0, ids: [] };
    e.score = Math.max(e.score, m.score); e.hits++; if (e.ids.length < 3) e.ids.push(m.id);
    byTenant.set(t, e);
  }
  // Best record first; several matching records lift a business a little (it offers more of the need).
  const ranked = [...byTenant.entries()].map(([tenant, e]) => ({ tenant, score: e.score + Math.min(0.03, 0.01 * (e.hits - 1)), hits: e.hits, ids: e.ids }))
    .sort((a, b) => b.score - a.score).slice(0, opts.limit || 12);
  // The matching lines themselves (evaluation and logs only - the callers judge with their own data).
  const ids = opts.withLines ? ranked.flatMap((r) => r.ids) : [];
  const text = new Map<string, string>();
  for (let k = 0; k < ids.length; k += 20) {
    const got = await cf("/get_by_ids", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids.slice(k, k + 20) }) }).catch(() => []);
    for (const v of got || []) text.set(v.id, String(v.metadata?.text || ""));
  }
  return ranked.map((r) => ({ tenant: r.tenant, score: r.score, hits: r.hits, lines: r.ids.map((id) => text.get(id) || "").filter(Boolean) }));
}
