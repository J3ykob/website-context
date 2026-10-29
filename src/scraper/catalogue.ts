/**
 * A shop's catalogue, read from the shop itself instead of crawling product pages (empro.pro,
 * 2026-10-29: 2,347 products behind ~3,000 sitemap URLs + 578 category pages; the crawl reached 20% of
 * them in 30+ minutes, the store API gives all of them in 24 requests). In order:
 *   1. WooCommerce Store API   /wp-json/wc/store/v1/products   (public on every WooCommerce shop)
 *   2. Shopify                 /products.json                  (public on every Shopify shop)
 *   3. The sitemap's product URLs, each page's JSON-LD Product only (no model; a few KB per page)
 * Products become offer items (source "shop": name, price, availability, SKU, categories, link) and their
 * pages are left out of the crawl; every other page is crawled as before. Below MIN_PRODUCTS the shop is
 * small enough for the normal crawl, and nothing changes.
 */
import * as cheerio from "cheerio";
import { safeFetch } from "./safe-url.js";
import { clean, type OfferItem } from "../offer/store.js";

export interface Catalogue { source: "woocommerce" | "shopify" | "sitemap"; items: OfferItem[]; productUrls: Set<string>; productPrefixes: string[] }

const MIN_PRODUCTS = () => Number(process.env.CATALOGUE_MIN_PRODUCTS) || 150;
const MAX_PRODUCTS = () => Number(process.env.CATALOGUE_MAX_PRODUCTS) || 10000;
const UA = "Mozilla/5.0 (compatible; WhispBot/1.0; +https://whisp.so)";

const strip = (html: string) => String(html || "").replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&#8217;/g, "'").replace(/&#8211;|&#8212;/g, "-").replace(/\s+/g, " ").trim();
const key = (u: string) => { try { const x = new URL(u); return `${x.hostname.replace(/^www\./, "")}${x.pathname.replace(/\/+$/, "")}`.toLowerCase(); } catch { return u.toLowerCase(); } };

async function getJson(url: string): Promise<{ data: any; headers: Headers } | null> {
  try {
    const r = await safeFetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
    if (!r.ok || !/json|javascript/.test(r.headers.get("content-type") || "")) return null; // Shopify's cart.js is JSON sent as JS
    return { data: JSON.parse(await r.text()), headers: r.headers };
  } catch { return null; }
}

// ── 1. WooCommerce ──
function wooItem(p: any): OfferItem | null {
  const pr = p?.prices || {};
  const div = 10 ** (Number(pr.currency_minor_unit) || 0);
  const amount = (v: unknown) => (v !== undefined && v !== null && String(v) !== "" ? Number(v) / div : null);
  const range = pr.price_range && typeof pr.price_range === "object" ? pr.price_range : null;
  const low = range ? amount(range.min_amount) : amount(pr.price);
  const high = range ? amount(range.max_amount) : null;
  const cats = [...new Set((Array.isArray(p.categories) ? p.categories : []).map((c: any) => strip(c?.name || "")).filter(Boolean))] as string[];
  const attrs = (Array.isArray(p.attributes) ? p.attributes : []).map((a: any) => `${strip(a?.name || "")}: ${(a?.terms || []).map((t: any) => strip(t?.name || "")).join(", ")}`).filter((x: string) => x.length > 3);
  const desc = [strip(p.short_description), strip(p.description)].filter(Boolean).join(" ").slice(0, 700);
  return clean({
    name: strip(p.name),
    category: cats.slice(-1)[0] || cats[0] || "",
    description: [p.sku ? `SKU: ${p.sku}` : "", cats.length > 1 ? `Kategorie: ${cats.join(", ")}` : "", attrs.length ? attrs.join("; ") : "", desc].filter(Boolean).join(". ").slice(0, 1000),
    price_value: low && low > 0 ? low : null,
    price_max: high && low !== null && high > low ? high : null,
    currency: pr.currency_code || "PLN",
    fields: { kind: "product", ...(low && low > 0 ? { price_type: high && high > (low || 0) ? "range" : "fixed" } : {}), ...(p.is_in_stock === true ? { availability: "in_stock" } : p.is_in_stock === false ? { availability: "unavailable" } : {}) },
    url: p.permalink || "",
  }, "shop");
}

async function fromWooCommerce(origin: string): Promise<OfferItem[] | null> {
  const first = await getJson(`${origin}/wp-json/wc/store/v1/products?per_page=100&page=1`);
  if (!first || !Array.isArray(first.data)) return null;
  const pages = Math.min(Number(first.headers.get("x-wp-totalpages")) || 1, Math.ceil(MAX_PRODUCTS() / 100));
  const out: any[] = [...first.data];
  for (let page = 2; page <= pages; page++) {
    const r = await getJson(`${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
    if (!r || !Array.isArray(r.data) || !r.data.length) break;
    out.push(...r.data);
  }
  return out.map(wooItem).filter(Boolean) as OfferItem[];
}

// ── 2. Shopify ──
async function fromShopify(origin: string): Promise<OfferItem[] | null> {
  const first = await getJson(`${origin}/products.json?limit=250&page=1`);
  if (!first || !Array.isArray(first.data?.products)) return null;
  const currency = ((await getJson(`${origin}/cart.js`))?.data?.currency as string) || "PLN";
  const all: any[] = [...first.data.products];
  for (let page = 2; all.length < MAX_PRODUCTS() && page <= 60; page++) {
    const r = await getJson(`${origin}/products.json?limit=250&page=${page}`);
    const ps = r?.data?.products;
    if (!Array.isArray(ps) || !ps.length) break;
    all.push(...ps);
  }
  return all.map((p) => {
    const prices = (p.variants || []).map((v: any) => Number(v.price)).filter((n: number) => n > 0);
    const low = prices.length ? Math.min(...prices) : null, high = prices.length ? Math.max(...prices) : null;
    const sku = (p.variants || []).map((v: any) => v.sku).filter(Boolean).slice(0, 3).join(", ");
    const opts = (p.options || []).filter((o: any) => o?.name && o.name !== "Title").map((o: any) => `${o.name}: ${(o.values || []).join(", ")}`);
    return clean({
      name: strip(p.title),
      category: strip(p.product_type || ""),
      description: [sku ? `SKU: ${sku}` : "", p.vendor ? `Producent: ${strip(p.vendor)}` : "", opts.join("; "), strip(p.body_html).slice(0, 700)].filter(Boolean).join(". ").slice(0, 1000),
      price_value: low, price_max: high && low && high > low ? high : null, currency,
      fields: { kind: "product", ...(low ? { price_type: high && low && high > low ? "range" : "fixed" } : {}), ...((p.variants || []).some((v: any) => v.available === true) ? { availability: "in_stock" } : (p.variants || []).length && (p.variants || []).every((v: any) => v.available === false) ? { availability: "unavailable" } : {}) },
      url: `${origin}/products/${p.handle}`,
    }, "shop");
  }).filter(Boolean) as OfferItem[];
}

// ── 3. Sitemap product URLs + JSON-LD ──
async function productSitemapUrls(origin: string): Promise<string[]> {
  const out = new Set<string>();
  const maps = [`${origin}/sitemap_index.xml`, `${origin}/sitemap.xml`, `${origin}/wp-sitemap.xml`];
  const seen = new Set<string>();
  const until = Date.now() + 45_000; // a slow or blocking sitemap must not hold the onboarding up (mrowka.com.pl: 10 min)
  while (maps.length && seen.size < 60 && Date.now() < until) {
    const m = maps.shift()!;
    if (seen.has(m)) continue;
    seen.add(m);
    try {
      const r = await safeFetch(m, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const xml = await r.text();
      const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/gi)].map((x) => x[1].replace(/&amp;/g, "&"));
      if (/<sitemapindex\b/i.test(xml)) { for (const l of locs) if (/product/i.test(l)) maps.push(l); }
      else if (/product/i.test(m)) for (const l of locs) { out.add(l); if (out.size >= MAX_PRODUCTS()) return [...out]; }
    } catch {}
  }
  return [...out];
}

async function fromSitemapJsonLd(origin: string): Promise<{ items: OfferItem[]; urls: string[] } | null> {
  const urls = await productSitemapUrls(origin);
  if (urls.length < MIN_PRODUCTS()) return null;
  const { fromJsonLd } = await import("../offer/index-scrape.js");
  const items: OfferItem[] = [];
  const done: string[] = [];
  let i = 0;
  const deadline = Date.now() + (Number(process.env.CATALOGUE_SITEMAP_MIN) || 20) * 60_000;
  // A sample first: pages without product data (most sites) are left to the normal crawl at once.
  let sampleHits = 0;
  const sampleUntil = Date.now() + 45_000;
  for (const u of urls.slice(0, 12)) {
    if (Date.now() > sampleUntil) break;
    try {
      const r = await safeFetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
      if (r.ok && fromJsonLd(cheerio.load(await r.text()), u).some((x) => x.fields.kind !== "service")) sampleHits++;
    } catch {}
  }
  if (sampleHits < 8) return null;
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (i < urls.length && Date.now() < deadline) {
      const u = urls[i++];
      try {
        const r = await safeFetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) continue;
        const found = fromJsonLd(cheerio.load(await r.text()), u).filter((x) => x.fields.kind !== "service");
        if (found.length) { items.push(...found.slice(0, 1).map((x) => ({ ...x, source: "shop" as const }))); done.push(u); }
      } catch {}
    }
  }));
  // Mostly no product data on the pages: not a catalogue we can read this way - the normal crawl does it.
  return items.length >= Math.min(MIN_PRODUCTS(), urls.length * 0.5) ? { items, urls: done } : null;
}

/** The shop's catalogue, or null for a site that is not a (large enough) shop. */
export async function readCatalogue(siteUrl: string): Promise<Catalogue | null> {
  let origin: string;
  try { origin = new URL(siteUrl).origin; } catch { return null; }
  const build = (source: Catalogue["source"], items: OfferItem[], extraUrls: string[] = []): Catalogue | null => {
    if (items.length < MIN_PRODUCTS()) return null;
    const urls = [...items.map((x) => x.url), ...extraUrls].filter(Boolean);
    // The common path prefix of product pages ("/produkt/", "/products/"): every product page under it is
    // left to the catalogue, also ones the API does not list (variants, hidden duplicates).
    const counts = new Map<string, number>();
    for (const u of urls) { try { const seg = new URL(u).pathname.split("/").filter(Boolean)[0]; if (seg) counts.set(seg, (counts.get(seg) || 0) + 1); } catch {} }
    const prefixes = [...counts.entries()].filter(([, n]) => n >= urls.length * 0.6).map(([s]) => `/${s}/`);
    return { source, items: items.slice(0, MAX_PRODUCTS()), productUrls: new Set(urls.map(key)), productPrefixes: prefixes };
  };
  // CATALOGUE_SOURCES (e.g. "sitemap"): which sources are tried - support and tests.
  const allow = (x: string) => !process.env.CATALOGUE_SOURCES || process.env.CATALOGUE_SOURCES.split(",").includes(x);
  const woo = allow("woocommerce") ? await fromWooCommerce(origin) : null;
  if (woo) return build("woocommerce", woo);
  const shopify = allow("shopify") ? await fromShopify(origin) : null;
  if (shopify) return build("shopify", shopify);
  if (!allow("sitemap")) return null;
  const sm = await fromSitemapJsonLd(origin);
  return sm ? build("sitemap", sm.items, sm.urls) : null;
}

/** Is this URL a product page the catalogue covers (so the crawl can skip it)? */
export function coveredByCatalogue(cat: Catalogue | null, url: string): boolean {
  if (!cat) return false;
  if (cat.productUrls.has(key(url))) return true;
  try { const p = new URL(url).pathname; return cat.productPrefixes.some((x) => p.startsWith(x) && p.length > x.length); } catch { return false; }
}

/** Live search in the shop (beyond our index, or when it was capped): WooCommerce / Shopify only. */
export async function searchShop(siteUrl: string, source: Catalogue["source"], query: string, limit = 8): Promise<OfferItem[]> {
  let origin: string;
  try { origin = new URL(siteUrl).origin; } catch { return []; }
  const q = encodeURIComponent(query.slice(0, 120));
  if (source === "woocommerce") {
    const r = await getJson(`${origin}/wp-json/wc/store/v1/products?search=${q}&per_page=${limit}`);
    return Array.isArray(r?.data) ? (r!.data.map(wooItem).filter(Boolean) as OfferItem[]) : [];
  }
  if (source === "shopify") {
    const r = await getJson(`${origin}/search/suggest.json?q=${q}&resources[type]=product&resources[limit]=${limit}`);
    const ps = r?.data?.resources?.results?.products;
    return Array.isArray(ps) ? (ps.map((p: any) => clean({ name: strip(p.title), category: strip(p.type || ""), description: strip(p.body || "").slice(0, 600), price_value: Number(p.price) || null, currency: "PLN", fields: { kind: "product", ...(Number(p.price) ? { price_type: "fixed" } : {}), ...(p.available === true ? { availability: "in_stock" } : {}) }, url: p.url ? `${origin}${p.url.split("?")[0]}` : "" }, "shop")).filter(Boolean) as OfferItem[]) : [];
  }
  return [];
}
