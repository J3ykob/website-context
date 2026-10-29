/**
 * The business's offer, as structured items: products and services described
 * by the fixed field/value schema (schema.ts) - price type and amount, unit,
 * availability, lead time, fulfilment... - plus price components for prices
 * made of several parts. Filled during scraping (structured data + Jev), by the
 * owner's onboarding spreadsheet, or in the dashboard; values the owner set are
 * never overwritten by a re-scrape. Stored per tenant in R2
 * (tenants/<id>/offer.json), cached in memory.
 */
import { randomUUID } from "crypto";
import { FIELDS, validValue, type FieldId, type PriceComponent, type BusinessType, BUSINESS_TYPES } from "./schema.js";

export type ItemFields = Partial<Record<FieldId, string>>;

export interface OfferItem {
  id: string;
  name: string;
  category: string;
  description: string;
  fields: ItemFields;            // field -> one of its schema values ("unknown" when not known)
  price_value: number | null;    // the price (lower bound for "from" / "range"), when stated
  price_max: number | null;      // upper bound for "range"
  currency: string;              // "PLN" unless stated otherwise
  components: PriceComponent[];  // a price made of several parts
  source: "manual" | "file" | "website" | "sheet" | "shop"; // shop = the store's own catalogue (src/scraper/catalogue.ts)
  owner_set: FieldId[];          // fields the owner set (a re-scrape keeps them)
  url: string;                   // where it was found (website items)
  updatedAt: string;
}

export interface Offer {
  version: 2;
  updatedAt: string;
  businessTypes: BusinessType[];
  items: OfferItem[];
}

const KEY = (tenantId: string) => `tenants/${tenantId}/offer.json`;
const MAX_ITEMS = 12000; // a shop catalogue (src/scraper/catalogue.ts) can be large; beyond it the chat searches the shop live
const cache = new Map<string, { offer: Offer; at: number }>();

export function emptyOffer(): Offer {
  return { version: 2, updatedAt: new Date().toISOString(), businessTypes: [], items: [] };
}

export async function loadOffer(tenantId: string): Promise<Offer> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.offer;
  const { downloadFromR2 } = await import("../storage/r2.js");
  let offer = emptyOffer();
  try {
    const buf = await downloadFromR2(KEY(tenantId));
    if (buf) {
      const j = JSON.parse(buf.toString("utf-8"));
      if (Array.isArray(j?.items)) {
        offer = {
          version: 2,
          updatedAt: String(j.updatedAt || ""),
          businessTypes: (Array.isArray(j.businessTypes) ? j.businessTypes : []).filter((t: string) => t in BUSINESS_TYPES),
          items: j.items.map((x: any) => clean(x)).filter(Boolean) as OfferItem[],
        };
      }
    }
  } catch (e: any) {
    console.warn(`[offer] ${tenantId}: load failed: ${e?.message || e}`);
  }
  cache.set(tenantId, { offer, at: Date.now() });
  return offer;
}

export async function saveOffer(tenantId: string, items: OfferItem[], businessTypes?: BusinessType[]): Promise<Offer> {
  const { uploadToR2 } = await import("../storage/r2.js");
  const prev = cache.get(tenantId)?.offer;
  const offer: Offer = { version: 2, updatedAt: new Date().toISOString(), businessTypes: businessTypes || prev?.businessTypes || [], items: items.slice(0, MAX_ITEMS) };
  const ok = await uploadToR2(KEY(tenantId), JSON.stringify(offer), "application/json");
  if (!ok) throw new Error("could not store the offer");
  cache.set(tenantId, { offer, at: Date.now() });
  return offer;
}

const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");
const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(",", ".")) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null;
};

function cleanComponent(raw: any): PriceComponent | null {
  const label = str(raw?.label, 120);
  if (!label) return null;
  return {
    label,
    price_type: validValue("price_type", raw?.price_type),
    price_value: num(raw?.price_value),
    price_max: num(raw?.price_max),
    unit: validValue("unit", raw?.unit),
    quantity_from: raw?.quantity_from === "customer" ? "customer" : "fixed",
    quantity_label: str(raw?.quantity_label, 80),
    combine: raw?.combine === "alternative" ? "alternative" : "sum",
  };
}

// Version-1 items (availability available|on_request|unavailable, price as text).
const V1_AVAIL: Record<string, string> = { available: "in_stock", on_request: "to_order", unavailable: "unavailable" };

/** A valid item from untrusted input (dashboard, spreadsheet, extraction, v1 data), or null. */
export function clean(raw: any, source?: OfferItem["source"]): OfferItem | null {
  const name = str(raw?.name, 200);
  if (!name) return null;
  const fields: ItemFields = {};
  const rf = raw?.fields && typeof raw.fields === "object" ? raw.fields : {};
  for (const f of Object.keys(FIELDS) as FieldId[]) {
    const val = validValue(f, rf[f]);
    if (val !== "unknown") fields[f] = val;
  }
  if (!fields.kind && (raw?.kind === "product" || raw?.kind === "service")) fields.kind = raw.kind;
  if (!fields.availability && typeof raw?.availability === "string" && V1_AVAIL[raw.availability]) fields.availability = V1_AVAIL[raw.availability];
  let price_value = num(raw?.price_value);
  if (price_value === null && typeof raw?.price === "string") {
    // v1 kept the price as text; keep its first number as the value.
    let digits = "", seen = false;
    for (const ch of raw.price) {
      if ((ch >= "0" && ch <= "9") || ((ch === "," || ch === ".") && seen)) { digits += ch; seen = true; }
      else if (seen && ch !== " ") break;
    }
    price_value = num(digits);
    if (price_value !== null && !fields.price_type) fields.price_type = "fixed";
  }
  return {
    id: str(raw?.id, 64) || randomUUID(),
    name,
    category: str(raw?.category, 100),
    description: str(raw?.description, 1000),
    fields,
    price_value,
    price_max: num(raw?.price_max),
    currency: str(raw?.currency, 8).toUpperCase() || "PLN",
    components: (Array.isArray(raw?.components) ? raw.components : []).slice(0, 20).map(cleanComponent).filter(Boolean) as PriceComponent[],
    source: source || (["file", "website", "sheet", "shop"].includes(raw?.source) ? raw.source : "manual"),
    owner_set: (Array.isArray(raw?.owner_set) ? raw.owner_set : []).filter((f: string) => f in FIELDS),
    url: str(raw?.url, 500),
    updatedAt: str(raw?.updatedAt, 40) || new Date().toISOString(),
  };
}

/**
 * Adds items; an item with the same name (case-insensitive) is updated, but
 * values the owner set on it are kept unless the incoming item is the owner's
 * (manual / sheet).
 */
export function mergeItems(existing: OfferItem[], incoming: OfferItem[]): OfferItem[] {
  const byName = new Map(existing.map((i) => [i.name.toLowerCase(), i]));
  for (const it of incoming) {
    const prev = byName.get(it.name.toLowerCase());
    if (!prev) { byName.set(it.name.toLowerCase(), it); continue; }
    const fromOwner = it.source === "manual" || it.source === "sheet";
    if (fromOwner) { byName.set(it.name.toLowerCase(), { ...it, id: prev.id, owner_set: [...new Set([...prev.owner_set, ...it.owner_set])] }); continue; }
    const fields: ItemFields = { ...it.fields };
    for (const f of prev.owner_set) if (prev.fields[f]) fields[f] = prev.fields[f];
    const keepPrice = prev.owner_set.includes("price_type");
    byName.set(it.name.toLowerCase(), {
      ...it, id: prev.id, fields, owner_set: prev.owner_set,
      price_value: keepPrice ? prev.price_value : it.price_value,
      price_max: keepPrice ? prev.price_max : it.price_max,
      components: prev.components.length && keepPrice ? prev.components : it.components,
    });
  }
  return [...byName.values()];
}

const fmt = (n: number) => { const t = n.toFixed(2); return (t.endsWith(".00") ? t.slice(0, -3) : t).split(".").join(","); };

/** The price in words, from the fields (no model). "" when nothing is known. */
export function priceText(i: Pick<OfferItem, "fields" | "price_value" | "price_max" | "currency" | "components">): string {
  const cur = i.currency === "PLN" ? "zł" : i.currency;
  const unit = i.fields.unit && i.fields.unit !== "unknown" ? ` / ${FIELDS.unit.values[i.fields.unit].label}` : "";
  const v = i.price_value;
  switch (i.fields.price_type) {
    case "fixed": return v !== null ? `${fmt(v)} ${cur}${unit}` : "";
    case "per_unit": return v !== null ? `${fmt(v)} ${cur}${unit}` : "";
    case "from": return v !== null ? `od ${fmt(v)} ${cur}${unit}` : "";
    case "range": return v !== null && i.price_max !== null ? `${fmt(v)}-${fmt(i.price_max)} ${cur}${unit}` : "";
    case "on_request": return "cena na zapytanie";
    case "free": return "bezpłatnie";
    case "included": return "w cenie";
    default: return v !== null ? `${fmt(v)} ${cur}${unit}` : "";
  }
}

/** One item as a line of text for the model and for checks (labels from the schema). */
export function renderItem(i: OfferItem): string {
  const parts = [`${i.fields.kind && i.fields.kind !== "unknown" ? FIELDS.kind.values[i.fields.kind].label : "Pozycja"}: ${i.name}`];
  if (i.category) parts.push(`Kategoria: ${i.category}`);
  parts.push(`Cena: ${priceText(i) || "nie podano"}`);
  for (const f of ["availability", "lead_time", "fulfilment", "delivery_cost", "min_order", "booking", "payment"] as FieldId[]) {
    const val = i.fields[f];
    if (val && val !== "unknown") parts.push(`${FIELDS[f].label}: ${FIELDS[f].values[val].label}`);
  }
  if (i.components.length) {
    const alt = i.components.every((c) => c.combine === "alternative");
    parts.push(`${alt ? "Stawki (do wyboru)" : "Składniki ceny (sumują się)"}: ${i.components.map((c) => `${c.label} - ${priceText({ fields: { price_type: c.price_type, unit: c.unit }, price_value: c.price_value, price_max: c.price_max, currency: i.currency, components: [] }) || "do wyceny"}${c.quantity_from === "customer" && c.quantity_label ? ` (ilość: ${c.quantity_label})` : ""}`).join("; ")}`);
  }
  if (i.description) parts.push(`Opis: ${i.description}`);
  return parts.join(" | ");
}
