/**
 * Products & services index built while a site is scraped.
 *
 *   1. Structured data (JSON-LD Product / Service / Offer): exact values, mapped
 *      by code.
 *   2. The readable text of every page is kept (no HTML). Jev skips pages that
 *      show no offer (blog posts, contact, policies) - one yes/no per page.
 *   3. An LLM reads each remaining page and fills the schema (extract.ts); code
 *      then checks it: the name must appear in the page text, a price's digits
 *      too, field values must be schema values - anything else is dropped.
 */
import * as cheerio from "cheerio";
import { jevAsk, type JevQuestion } from "../llm/jev.js";
import { BUSINESS_TYPES, FIELDS, type BusinessType, type FieldId } from "./schema.js";
import { clean, mergeItems, type OfferItem } from "./store.js";
import { extractFromBlock, type Llm } from "./extract.js";

const MAX_PAGES = 150;      // pages an LLM reads per site
const PAGE_TEXT = 6000;     // characters of each page it reads

// Whitespace collapsed by scanning characters (no regex in extraction).
function squash(t: string): string {
  let out = "", space = false;
  for (const ch of t) {
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === " ") { space = out.length > 0; continue; }
    if (space) { out += " "; space = false; }
    out += ch;
  }
  return out;
}

function parseNumber(t: string): number | null {
  const lastSep = Math.max(t.lastIndexOf(","), t.lastIndexOf("."));
  let intPart = t, dec = "";
  if (lastSep >= 0 && t.length - lastSep - 1 <= 2) { intPart = t.slice(0, lastSep); dec = t.slice(lastSep + 1); }
  intPart = [...intPart].filter((c) => c >= "0" && c <= "9").join("");
  const n = Number(dec ? `${intPart}.${dec}` : intPart);
  return intPart && Number.isFinite(n) ? n : null;
}

const SCHEMA_AVAIL: Record<string, string> = { InStock: "in_stock", OnlineOnly: "in_stock", InStoreOnly: "in_stock", OutOfStock: "unavailable", SoldOut: "unavailable", Discontinued: "unavailable", PreOrder: "to_order", BackOrder: "to_order", PreSale: "to_order", MadeToOrder: "to_order", LimitedAvailability: "limited" };

function* walk(node: any): Generator<any> {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  yield node;
  for (const v of Object.values(node)) if (v && typeof v === "object") yield* walk(v);
}

/** Items a page declares in JSON-LD - exact, no model. */
function fromJsonLd($: cheerio.CheerioAPI, url: string): OfferItem[] {
  const out: OfferItem[] = [];
  $('script[type="application/ld+json"]').each((_: any, el: any) => {
    let data: any;
    try { data = JSON.parse($(el).contents().text()); } catch { return; }
    for (const n of walk(data)) {
      const t = [].concat(n["@type"] || []).join(" ");
      if (!(t.includes("Product") || t.includes("Service")) || typeof n.name !== "string") continue;
      const offer = ([].concat(n.offers || []) as any[]).find((o) => o && typeof o === "object");
      const price = offer ? (offer.price ?? offer.lowPrice ?? offer.priceSpecification?.price) : undefined;
      const avail = offer && typeof offer.availability === "string" ? SCHEMA_AVAIL[offer.availability.split("/").pop() || ""] : undefined;
      const hasPrice = price !== undefined && price !== null && String(price) !== "";
      const it = clean({
        name: squash(n.name),
        description: typeof n.description === "string" ? squash(n.description).slice(0, 300) : "",
        category: typeof n.category === "string" ? n.category : "",
        price_value: hasPrice ? parseNumber(String(price)) : null,
        price_max: offer?.highPrice !== undefined ? parseNumber(String(offer.highPrice)) : null,
        currency: typeof offer?.priceCurrency === "string" ? offer.priceCurrency : "PLN",
        fields: { kind: t.includes("Service") ? "service" : "product", ...(avail ? { availability: avail } : {}), ...(hasPrice ? { price_type: offer?.highPrice !== undefined ? "range" : "fixed" } : {}) },
        url,
      }, "website");
      if (it) out.push(it);
    }
  });
  return out;
}

/** A page's text as blocks: each element's own text, in document order. */
function textBlocks($: cheerio.CheerioAPI): string[] {
  const out: string[] = [];
  $("body *").each((_: any, el: any) => {
    let own = "";
    for (const n of el.children || []) if (n.type === "text") own += ` ${n.data}`;
    own = squash(own);
    if (own.length >= 2) out.push(own);
  });
  return out;
}

/**
 * Collects, during the crawl, JSON-LD items and each page's text blocks (HTML
 * is not kept). Blocks repeated on many pages - menus, sidebars, footers that
 * are not marked as navigation - are dropped at the end, so the model reads
 * what each page itself presents.
 */
export function createOfferIndexer() {
  const pages: { url: string; title: string; blocks: string[] }[] = [];
  const seenOn = new Map<string, number>();
  let jsonLd: OfferItem[] = [];
  return {
    addPage(html: string, url: string): void {
      try {
        const $ = cheerio.load(html);
        jsonLd = mergeItems(jsonLd, fromJsonLd($, url));
        const title = squash($("title").first().text()).slice(0, 150);
        $("script,style,noscript,nav,header,footer,form,[role='navigation'],[role='contentinfo']").remove();
        const blocks = textBlocks($);
        for (const b of new Set(blocks)) seenOn.set(b, (seenOn.get(b) || 0) + 1);
        pages.push({ url, title, blocks });
      } catch {}
    },
    get size() { return pages.length; },
    finish: (llm: Llm) => {
      const limit = Math.max(3, Math.ceil(pages.length * 0.4));
      const texts = pages
        .map((p) => ({ url: p.url, title: p.title, text: p.blocks.filter((b) => pages.length < 4 || (seenOn.get(b) || 0) < limit).join(" ").slice(0, PAGE_TEXT) }))
        .filter((p) => p.text.length >= 80);
      return buildIndex(texts, jsonLd, llm);
    },
  };
}

async function pool<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const out: T[] = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => { while (i < jobs.length) { const k = i++; out[k] = await jobs[k](); } }));
  return out;
}

/** Business types of the site (Jev, one call, from the first page). */
async function businessTypes(siteText: string): Promise<BusinessType[]> {
  const types = Object.keys(BUSINESS_TYPES) as BusinessType[];
  const a = await jevAsk({ website_text: siteText.slice(0, 3000) }, Object.fromEntries(types.map((t) => [t, { type: "noul", instructions: `Is this business (judging by \`website_text\`) of this kind: ${BUSINESS_TYPES[t].meaning}` } as JevQuestion])), 8000);
  const picked = types.filter((t) => t !== "other" && (((a?.[t] as any)?.noul as number) ?? 0) >= 0.6);
  return picked.length ? picked : ["other"];
}

/** Pages that show the business's offer (Jev yes/no each); all pages when Jev is unavailable. */
async function offerPages(pages: { url: string; title: string; text: string }[]): Promise<typeof pages> {
  const batches: (typeof pages)[] = [];
  for (let k = 0; k < pages.length; k += 25) batches.push(pages.slice(k, k + 25));
  const kept = await pool(4, batches.map((b) => async () => {
    const a = await jevAsk({ pages: b.map((p) => `${p.title} - ${p.text.slice(0, 400)}`) }, Object.fromEntries(b.map((_, k) => [`p${k}`, {
      type: "noul",
      instructions: `Does \`pages[${k}]\` show products or services this business offers (an offer, price list, catalog, product or service page), as opposed to only news, contact, policies or general information?`,
    } as JevQuestion])), 12000);
    return a ? b.filter((_, k) => (((a[`p${k}`] as any)?.noul as number) ?? 1) >= 0.4) : b;
  }));
  return kept.flat();
}

/**
 * The model proposes, Jev verifies: every field value the model filled in is
 * checked against the page text ("does the text state that ... is ...?", yes /
 * no each, one call per item). Values the text does not state go back to
 * "unknown" - the model tends to fill typical values for the kind of business.
 */
async function verifyFields(it: OfferItem, pageText: string): Promise<OfferItem> {
  const claims = (Object.keys(it.fields) as FieldId[]).filter((f) => f !== "kind" && it.fields[f] && it.fields[f] !== "unknown" && FIELDS[f].values[it.fields[f]!]);
  if (!claims.length) return it;
  const a = await jevAsk({ item: it.name, page_text: pageText.slice(0, 5000) }, Object.fromEntries(claims.map((f) => [f, {
    type: "noul",
    instructions: `Does \`page_text\` state or clearly show, for \`item\` (or for the whole offer it belongs to), this: ${FIELDS[f].label} - ${FIELDS[f].values[it.fields[f]!].meaning}? Answer no when it is only typical or likely but not stated.`,
  } as JevQuestion])), 8000);
  if (!a) return it; // Jev unavailable: keep the model's values
  const fields = { ...it.fields };
  for (const f of claims) if ((((a[f] as any)?.noul as number) ?? 0) < 0.5) delete fields[f];
  if (!fields.price_type && it.price_value !== null) fields.price_type = "fixed";
  return { ...it, fields };
}

/**
 * The same offer found under two names on different pages ("Remonty łazienek" /
 * "Kompleksowe remonty łazienek"): Jev judges each item against the items kept
 * before it in the same category (yes / no each); a duplicate is folded into the
 * kept item, keeping known values.
 */
async function dedupe(items: OfferItem[]): Promise<OfferItem[]> {
  const kept: OfferItem[] = [];
  for (const it of items) {
    const near = kept.slice(-60);
    let same = -1;
    if (near.length) {
      const a = await jevAsk({ item: `${it.name}${it.description ? ` - ${it.description.slice(0, 120)}` : ""}`, others: near.map((k) => k.name) }, Object.fromEntries(near.map((_, k) => [`s${k}`, { type: "noul", instructions: `Are \`item\` and \`others[${k}]\` the same product or service of this business (just named differently), not two different ones?` } as JevQuestion])), 6000);
      let best = 0.7;
      near.forEach((_, k) => { const p = ((a?.[`s${k}`] as any)?.noul as number) ?? 0; if (p >= best) { best = p; same = kept.indexOf(near[k]); } });
    }
    if (same < 0) { kept.push(it); continue; }
    const k = kept[same];
    const short = k.name.length <= it.name.length ? k : it;
    kept[same] = {
      ...k, name: short.name,
      description: k.description || it.description,
      fields: { ...it.fields, ...Object.fromEntries(Object.entries(k.fields).filter(([, v]) => v && v !== "unknown")) },
      price_value: k.price_value ?? it.price_value, price_max: k.price_max ?? it.price_max,
      components: k.components.length ? k.components : it.components,
    };
  }
  return kept;
}

async function buildIndex(pages: { url: string; title: string; text: string }[], jsonLd: OfferItem[], llm: Llm): Promise<{ businessTypes: BusinessType[]; items: OfferItem[]; stats: Record<string, number> }> {
  const t0 = Date.now();
  if (!pages.length && !jsonLd.length) return { businessTypes: [], items: [], stats: { pages: 0 } };
  const types = await businessTypes(pages[0]?.text || "");
  const withOffer = (await offerPages(pages)).slice(0, MAX_PAGES);
  let items = jsonLd;
  const perPage = await pool(8, withOffer.map((p) => async () => {
    try {
      const found = (await extractFromBlock(`${p.title}\n${p.text}`, llm, "website")).map((it) => ({ ...it, url: p.url }));
      return await pool(4, found.map((it) => () => verifyFields(it, p.text)));
    }
    catch (e: any) { console.warn(`[offer-index] ${p.url}: ${e?.message || e}`); return []; }
  }));
  for (const list of perPage) items = mergeItems(items, list);
  items = await dedupe(items);
  const priced = items.filter((i) => i.price_value !== null || ["on_request", "free", "included"].includes(i.fields.price_type || "")).length;
  return { businessTypes: types, items, stats: { pages: pages.length, offerPages: withOffer.length, jsonLd: jsonLd.length, items: items.length, priced, ms: Date.now() - t0 } };
}
