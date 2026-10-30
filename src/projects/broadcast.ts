/**
 * The network's offers for a customer's request (the customer's project): the request split into parts
 * (neutral wording, no personal data - only the parts leave the project), and per part the businesses that
 * offer it - found by the network's one search (src/network/find.ts, the same one the chat uses). Their
 * matched items with prices are precise offers; the rest are "does this, price to agree" and get asked.
 * Arithmetic is not trusted here - the agent recomputes.
 */
import type { OfferItem } from "../offer/store.js";

const MODEL = () => process.env.NETWORK_MODEL || "deepseek/deepseek-v4.1-flash";
const PICKS = 3;   // offers picked per part
const MAX_PARTS = 8;

export interface NetworkOffer { tenantId: string; part: number; precise: boolean; text: string; items: OfferItem[] }
export interface Broadcast { parts: string[]; answered: number; declined: number; picked: NetworkOffer[]; ms: number }

async function llmJson(system: string, user: string, maxTokens = 1200): Promise<any> {
  for (let k = 0; k < 2; k++) {
    try {
      const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(60_000),
        headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL(), temperature: 0, max_tokens: maxTokens, response_format: { type: "json_object" }, provider: (await import("../llm/pin.js")).routingFor(MODEL()).provider, seed: 7, reasoning: { enabled: false },
          messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
      });
      const j = (await r.json()) as any;
      return JSON.parse(j?.choices?.[0]?.message?.content || "");
    } catch { /* one retry */ }
  }
  return null;
}

const SPLIT = `Rozpisujesz prośbę klienta na części, o które sieć firm ma złożyć oferty. Zwróć JSON {"parts": ["..."]}:
jedna część = jeden produkt lub usługa, po polsku, z ilościami, wymiarami i czasem z prośby (przelicz oczywiste:
wymiary -> powierzchnia lub objętość, dni tygodnia -> liczba dób). Bez danych osobowych klienta (imię, nazwisko,
telefon, e-mail, dokładny adres - zostaw najwyżej miejscowość lub dzielnicę). Tylko to, o co klient prosi.
Gdy wiadomość nie prosi o żaden produkt ani usługę: {"parts": []}.`;

/** The request as parts the network can quote (neutral, without personal data). */
export async function splitNeed(need: string): Promise<string[]> {
  // Stored per normalised request: hosted models are not repeatable even at temperature 0 with a fixed
  // provider and seed (measured 2026-10-30: 2 different splits in 4 calls), so the same request is split
  // once and the split reused - every later step sees the same parts.
  const norm = need.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 3000);
  const { createHash } = await import("crypto");
  const key = `decisions/split/${createHash("sha1").update(`v1\n${norm}`).digest("hex")}.json`;
  const hit = splitMemo.get(key);
  if (hit) return hit;
  const { downloadFromR2, uploadToR2 } = await import("../storage/r2.js");
  const stored = await downloadFromR2(key).then((b) => (b ? JSON.parse(b.toString("utf-8")) : null)).catch(() => null);
  if (Array.isArray(stored)) { splitMemo.set(key, stored); return stored; }
  const j = await llmJson(SPLIT, need.slice(0, 3000), 800);
  if (!j) return []; // the model failed: nothing stored, the next call tries again
  const parts = (Array.isArray(j?.parts) ? j.parts : []).filter((p: unknown): p is string => typeof p === "string" && p.trim().length > 2).map((p: string) => p.trim().slice(0, 300)).slice(0, MAX_PARTS);
  if (splitMemo.size > 5000) splitMemo.clear();
  splitMemo.set(key, parts);
  await uploadToR2(key, JSON.stringify(parts), "application/json").catch(() => {});
  return parts;
}
const splitMemo = new Map<string, string[]>();

/**
 * The whole round. tenantIds: the network (only for its name); ownFirst: the business running the project -
 * it competes like any other, and when its own price list prices every part, nobody else is asked.
 * Never throws: a failure means no network offers.
 */
export async function broadcastNeed(need: string, tenantIds: string[], ownFirst?: string): Promise<Broadcast> {
  const t0 = Date.now();
  const { getTenant } = await import("../multi-tenant/d1-registry.js");
  const eco = getTenant(ownFirst || tenantIds[0])?.settings?.ecosystem;
  if (typeof eco !== "string" || !eco) return { parts: [], answered: 0, declined: 0, picked: [], ms: 0 };
  const { findBusinesses } = await import("../network/find.js");
  const r = await findBusinesses(need, eco, { include: ownFirst }).catch(() => null);
  if (!r) return { parts: [], answered: 0, declined: tenantIds.length, picked: [], ms: Date.now() - t0 };
  const mine = r.hits.filter((h) => h.tenantId === ownFirst && h.precise);
  const covered = r.parts.length > 0 && r.parts.every((_, k) => mine.some((h) => h.part === k));
  const hits = covered ? mine : r.hits;
  const picked: NetworkOffer[] = r.parts.flatMap((_, k) => hits.filter((h) => h.part === k).slice(0, PICKS)
    .map((h) => ({ tenantId: h.tenantId, part: k, precise: h.precise, text: `${h.label}: ${h.text}`, items: h.items })));
  const answered = new Set(r.hits.map((h) => h.tenantId)).size;
  return { parts: r.parts, answered, declined: Math.max(0, r.asked - answered), picked, ms: Date.now() - t0 };
}
