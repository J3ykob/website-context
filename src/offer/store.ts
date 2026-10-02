/**
 * The business's offer, as structured items the owner maintains in the
 * dashboard (typed, imported from a price list, or extracted from the website):
 * products and services with category, price and availability. It is the
 * authoritative source for "do you have X / how much is Y" in the chat and for
 * the offer check in chat forms. Stored per tenant in R2
 * (tenants/<id>/offer.json), cached in memory.
 */
import { randomUUID } from "crypto";

export type Availability = "available" | "on_request" | "unavailable";

export interface OfferItem {
  id: string;
  kind: "product" | "service";
  name: string;
  category: string;
  description: string;
  price: string;        // as the owner writes it, e.g. "32 zł / worek", "od 150 zł", "" = not given
  availability: Availability;
  source: "manual" | "file" | "website";
  updatedAt: string;
}

export interface Offer {
  version: 1;
  updatedAt: string;
  items: OfferItem[];
}

const KEY = (tenantId: string) => `tenants/${tenantId}/offer.json`;
const MAX_ITEMS = 5000;
const cache = new Map<string, { offer: Offer; at: number }>();

export function emptyOffer(): Offer {
  return { version: 1, updatedAt: new Date().toISOString(), items: [] };
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
      if (Array.isArray(j?.items)) offer = { version: 1, updatedAt: String(j.updatedAt || ""), items: j.items.map(clean).filter(Boolean) as OfferItem[] };
    }
  } catch (e: any) {
    console.warn(`[offer] ${tenantId}: load failed: ${e?.message || e}`);
  }
  cache.set(tenantId, { offer, at: Date.now() });
  return offer;
}

export async function saveOffer(tenantId: string, items: OfferItem[]): Promise<Offer> {
  const { uploadToR2 } = await import("../storage/r2.js");
  const offer: Offer = { version: 1, updatedAt: new Date().toISOString(), items: items.slice(0, MAX_ITEMS) };
  const ok = await uploadToR2(KEY(tenantId), JSON.stringify(offer), "application/json");
  if (!ok) throw new Error("could not store the offer");
  cache.set(tenantId, { offer, at: Date.now() });
  return offer;
}

const str = (v: unknown, n: number) => (typeof v === "string" ? v.trim().slice(0, n) : "");

/** A valid item from untrusted input (dashboard / model output), or null. */
export function clean(raw: any, source?: OfferItem["source"]): OfferItem | null {
  const name = str(raw?.name, 200);
  if (!name) return null;
  const availability: Availability = raw?.availability === "on_request" || raw?.availability === "unavailable" ? raw.availability : "available";
  return {
    id: str(raw?.id, 64) || randomUUID(),
    kind: raw?.kind === "service" ? "service" : "product",
    name,
    category: str(raw?.category, 100),
    description: str(raw?.description, 1000),
    price: str(raw?.price, 100),
    availability,
    source: source || (raw?.source === "file" || raw?.source === "website" ? raw.source : "manual"),
    updatedAt: str(raw?.updatedAt, 40) || new Date().toISOString(),
  };
}

/** Adds items, replacing an existing one with the same name (case-insensitive). */
export function mergeItems(existing: OfferItem[], incoming: OfferItem[]): OfferItem[] {
  const byName = new Map(existing.map((i) => [i.name.toLowerCase(), i]));
  for (const it of incoming) {
    const prev = byName.get(it.name.toLowerCase());
    byName.set(it.name.toLowerCase(), prev ? { ...it, id: prev.id } : it);
  }
  return [...byName.values()];
}

const AVAIL_PL: Record<Availability, string> = { available: "dostępne", on_request: "na zamówienie / do potwierdzenia", unavailable: "niedostępne" };

/** One item as a line of text for the model and for checks. */
export function renderItem(i: OfferItem): string {
  return [
    `${i.kind === "service" ? "Usługa" : "Produkt"}: ${i.name}`,
    i.category ? `Kategoria: ${i.category}` : "",
    i.price ? `Cena: ${i.price}` : "Cena: nie podano",
    `Dostępność: ${AVAIL_PL[i.availability]}`,
    i.description ? `Opis: ${i.description}` : "",
  ].filter(Boolean).join(" | ");
}
