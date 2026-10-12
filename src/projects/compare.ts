/**
 * Project type compare_offers@1: "what would this list / this job cost?" across
 * the businesses of the network that have a structured offer.
 *
 *   1. The model splits the request into lines (need, quantity, unit); a
 *      quantity is kept only if its digits appear in the customer's words.
 *   2. Jev matches every line to every business's offer items.
 *   3. Code prices each line from the offer fields: parts that add up are
 *      summed, alternative rates are picked by the customer's unit, "on
 *      request" / unknown prices and unit mismatches become TBD.
 *   4. Code assigns each line: the asking business if it has a price, else the
 *      cheapest business with a price, else TBD with the business that has it
 *      on request, else "not found in the network".
 *   5. The model words the summary in the customer's language; code checks
 *      every number in it comes from the computed data, otherwise a table built
 *      by code is shown instead.
 * Everything is recorded in the project (memory, participants, events, usage).
 */
import { findOfferItems } from "../offer/search.js";
import { jevAsk, type JevQuestion } from "../llm/jev.js";
import { FIELDS, validValue } from "../offer/schema.js";
import type { OfferItem } from "../offer/store.js";
import { createProject, addParticipant, addEvent, setMemory, addUsage, setStatus } from "./store.js";

export type Llm = (system: string, user: string, maxTokens?: number) => Promise<string>;
export interface Business { tenantId: string; label: string; items: OfferItem[] }
export interface Line { need: string; quantity: number | null; unit: string; needInCatalog: string }
export interface Quote {
  tenantId: string;
  label: string;
  item: string;               // the offer item's name
  unitPrice: number | null;   // per the item's unit
  unit: string;               // schema unit of the price
  total: number | null;       // for the line's quantity, when computable
  priceNote: string;          // e.g. "od", "na zapytanie", "stawka dobowa"
  tbd: string[];              // parts priced on request
  leadTime: string;
  availability: string;
}
export interface LineResult { line: Line; quotes: Quote[]; assigned: Quote | null; status: "priced" | "tbd" | "not_found"; reason: string }

/** Why a line has no price, decided by code (the summary must say exactly this). */
function reasonOf(status: LineResult["status"], q: Quote | null, line: Line): string {
  if (status === "priced") return "";
  if (status === "not_found" || !q) return "not offered by any business in the network";
  if (q.tbd.length && q.unitPrice === null && !q.total) return "price on request";
  if (q.tbd.length) return `partly priced on request (${q.tbd.join(", ")})`;
  if (line.quantity === null) return "quantity not given";
  return "price unit differs from the requested quantity (unit price shown)";
}
export interface CompareResult { projectId: string; lines: LineResult[]; total: number; tbdLines: number; currency: string; message: string }

const r2 = (n: number) => Math.round(n * 100) / 100;
function digitsOf(t: string): string { let d = ""; for (const ch of t) if (ch >= "0" && ch <= "9") d += ch; return d; }
/** Numbers written in a text ("28,90" -> "28.90"), by scanning characters. */
function numbersIn(t: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of t + " ") {
    if ((ch >= "0" && ch <= "9") || ((ch === "." || ch === ",") && cur)) cur += ch === "," ? "." : ch;
    else { if (cur) out.push(cur.endsWith(".") ? cur.slice(0, -1) : cur); cur = ""; }
  }
  return out;
}
function json(raw: string): any { const a = raw.indexOf("{"), b = raw.lastIndexOf("}"); try { return a >= 0 && b > a ? JSON.parse(raw.slice(a, b + 1)) : null; } catch { return null; } }

/** The request as lines. Quantities must appear in the customer's own words. */
export async function parseLines(message: string, llm: Llm, catalogSample: string[] = []): Promise<Line[]> {
  const units = Object.keys(FIELDS.unit.values).join("|");
  const j = json(await llm(
    "You split a customer's request into the products / services it asks for. Output only JSON.",
    `Customer's message: """${message.slice(0, 2000)}"""

Output {"lines": [{"need": "what they need, in their words", "need_in_catalog": "the same need written the way the business's catalog names it", "quantity": number|null, "unit": ${units}}]}.
${catalogSample.length ? `The business's catalog names items like this: ${catalogSample.slice(0, 15).join("; ")}. "need_in_catalog" uses that language and the common trade name a professional in that language would use (a translation of the meaning if the customer writes in another language, e.g. "demolition hammer" -> "młot wyburzeniowy").` : `"need_in_catalog": same as need.`}
- One line per distinct product or service (a job like "remont łazienki 6 m2" is one line: need "remont łazienki", quantity 6, unit "m2").
- "need" keeps everything that describes the product, including sizes, weights and models ("zagęszczarka 90 kg").
- quantity = HOW MANY or HOW LONG the customer wants it (pieces, m², tonnes ordered, days or hours of rental) - never a size, weight or model number that is part of the product ("zagęszczarka 90 kg na 3 doby" -> quantity 3, unit "doba"). Only as the customer states it; null / "unknown" otherwise. Never guess.`,
    800,
  ));
  const md = digitsOf(message);
  return (Array.isArray(j?.lines) ? j.lines : []).slice(0, 15).map((l: any) => {
    const q = typeof l?.quantity === "number" && l.quantity > 0 ? l.quantity : null;
    return {
      need: String(l?.need || "").trim().slice(0, 200),
      needInCatalog: String(l?.need_in_catalog || l?.need || "").trim().slice(0, 200),
      quantity: q !== null && md.includes(digitsOf(String(q))) ? q : null,
      unit: q !== null ? validValue("unit", l?.unit) : "unknown",
    };
  }).filter((l: Line) => l.need);
}

/** Price of one offer item for one line - from the item's fields only. */
export function priceLine(it: OfferItem, line: Line, b: Business): Quote {
  const f = it.fields;
  const base: Quote = {
    tenantId: b.tenantId, label: b.label, item: it.name, unitPrice: null, unit: f.unit || "unknown", total: null, priceNote: "",
    tbd: [], leadTime: f.lead_time && f.lead_time !== "unknown" ? FIELDS.lead_time.values[f.lead_time].label : "",
    availability: f.availability && f.availability !== "unknown" ? FIELDS.availability.values[f.availability].label : "",
  };
  const qtyFor = (unit: string) => (line.quantity !== null && (unit === line.unit || (line.unit === "unknown" && unit === "szt")) ? line.quantity : null);

  if (it.components.length) {
    const alts = it.components.filter((c) => c.combine === "alternative");
    if (alts.length === it.components.length) {
      // Alternative rates: the one in the customer's unit, else show the lowest.
      const match = alts.find((c) => c.unit === line.unit && c.price_value !== null);
      const pick = match || [...alts].filter((c) => c.price_value !== null).sort((a, b) => a.price_value! - b.price_value!)[0];
      if (!pick) return { ...base, priceNote: "na zapytanie", tbd: [it.name] };
      const q = match ? line.quantity : null;
      return { ...base, unitPrice: pick.price_value, unit: pick.unit, total: q !== null ? r2(pick.price_value! * q) : null, priceNote: pick.label };
    }
    // Parts that add up.
    let sum = 0, known = true;
    const tbd: string[] = [];
    for (const c of it.components) {
      if (c.price_value === null || ["on_request", "unknown", "not_listed"].includes(c.price_type)) { tbd.push(c.label); continue; }
      const q = c.quantity_from === "customer" ? qtyFor(c.unit) : 1;
      if (q === null) { known = false; tbd.push(`${c.label} (${c.quantity_label || FIELDS.unit.values[c.unit]?.label || "ilość"})`); continue; }
      sum += c.price_value * q;
    }
    return { ...base, total: known || sum > 0 ? r2(sum) : null, priceNote: tbd.length ? "częściowo do wyceny" : "suma składników", tbd };
  }

  const pt = f.price_type || "unknown";
  if (it.price_value === null || ["on_request", "unknown", "not_listed"].includes(pt)) return { ...base, priceNote: pt === "free" ? "bezpłatnie" : "na zapytanie", total: pt === "free" ? 0 : null, unitPrice: pt === "free" ? 0 : null, tbd: pt === "free" ? [] : [it.name] };
  const q = pt === "fixed" && (f.unit === "usluga" || f.unit === "projekt" || !f.unit) ? 1 : qtyFor(base.unit);
  return {
    ...base, unitPrice: it.price_value,
    total: q !== null && pt !== "range" ? r2(it.price_value * q) : null,
    priceNote: pt === "from" ? "od" : pt === "range" ? `${it.price_value}-${it.price_max}` : "",
  };
}

/** Runs the whole comparison and records it as a project. */
export async function runCompare(opts: {
  message: string; customerSession: string; askingTenantId: string; businesses: Business[]; llm: Llm; language?: string;
}): Promise<CompareResult | null> {
  const { message, businesses, llm } = opts;
  let llmCalls = 0, jevCalls = 0;
  const sample = businesses.flatMap((b) => b.items.slice(0, 5).map((i) => i.name)).slice(0, 15);
  const lines = await parseLines(message, llm, sample); llmCalls++;
  if (!lines.length) return null;
  // The project record must never block or break the customer's answer.
  const project = await Promise.race([
    createProject("compare_offers@1", { customerSession: opts.customerSession, initiatorTenantId: opts.askingTenantId, title: lines.map((l) => l.need).join(", ").slice(0, 200), memory: { request: message.slice(0, 2000), lines } }),
    new Promise<null>((r) => setTimeout(() => r(null), 8000)),
  ]).catch((e) => { console.warn(`[project] create failed: ${(e as Error).message}`); return null; });
  if (!project) console.warn("[project] compare_offers: no project record (D1 slow or failing) - answering anyway");
  const record = (fn: () => Promise<unknown>) => (project ? fn().catch((e) => console.warn(`[project] ${project.id}: write failed: ${(e as Error).message}`)) : Promise.resolve());

  const results: LineResult[] = await Promise.all(lines.map(async (line) => {
    const quotes = (await Promise.all(businesses.map(async (b) => {
      if (!b.items.length) return null;
      jevCalls++;
      let hit = (await findOfferItems(line.need, b.items, 1, 0.7).catch(() => []))[0];
      if (!hit && line.needInCatalog && line.needInCatalog !== line.need) { jevCalls++; hit = (await findOfferItems(line.needInCatalog, b.items, 1, 0.7).catch(() => []))[0]; }
      return hit ? priceLine(hit, line, b) : null;
    }))).filter(Boolean) as Quote[];
    const priced = quotes.filter((q) => q.total !== null && q.tbd.length === 0);
    const own = priced.find((q) => q.tenantId === opts.askingTenantId);
    const cheapest = [...priced].sort((a, b) => a.total! - b.total!)[0];
    const assigned = own || cheapest || quotes.find((q) => q.tenantId === opts.askingTenantId) || quotes[0] || null;
    const status: LineResult["status"] = !quotes.length ? "not_found" : assigned && assigned.total !== null && assigned.tbd.length === 0 ? "priced" : "tbd";
    return { line, quotes, assigned, status, reason: reasonOf(status, assigned, line) };
  }));

  const total = r2(results.reduce((s, r) => s + (r.status === "priced" ? r.assigned!.total! : 0), 0));
  const tbdLines = results.filter((r) => r.status !== "priced").length;
  const involved = new Set(results.flatMap((r) => r.quotes.map((q) => q.tenantId)));
  const writes: Promise<unknown>[] = [];
  for (const t of involved) if (t !== opts.askingTenantId) writes.push(record(() => addParticipant(project!.id, t, results.some((r) => r.assigned?.tenantId === t) ? "chosen" : "quoting")));
  writes.push(record(() => addEvent(project!.id, { kind: "quotes", actor: "system", data: { lines: results.length, priced: results.length - tbdLines, businesses: involved.size } })));

  // Words by the model, numbers checked by code.
  const data = results.map((r) => {
    const a = r.assigned;
    const base = { need: r.line.need, quantity: r.line.quantity, unit: r.line.unit === "unknown" ? "" : FIELDS.unit.values[r.line.unit].label };
    if (r.status === "priced") return {
      ...base, state: "PRICED", business: a!.label, item: a!.item, total: a!.total,
      unit_price: a!.unitPrice, price_unit: a!.unit !== "unknown" ? FIELDS.unit.values[a!.unit]?.label : "",
      lead_time: a!.leadTime, availability: a!.availability,
      other_offers: r.quotes.filter((q) => q !== a && q.total !== null).map((q) => ({ business: q.label, total: q.total })).slice(0, 3),
    };
    return {
      ...base, state: "TO BE PRICED", reason: r.reason, business: a?.label || "", item: a?.item || "",
      unit_price_for_information: a?.unitPrice ?? null, price_unit: a && a.unit !== "unknown" ? FIELDS.unit.values[a.unit]?.label : "",
    };
  });
  let msg = "";
  try {
    msg = (await llm(
    `You present a price comparison to a customer. Write in ${opts.language || "the same language as the customer's message"}. Use only the numbers, names and facts in DATA - never compute, round or add any other number. Short; one line per need. A need with state "PRICED" has its total - present it as the price, never as "to be priced". A need with state "TO BE PRICED" has no total: say it is to be priced and give exactly its reason (a unit price may be mentioned as information). End with the known total ${total} zł${tbdLines ? " plus the items to be priced" : ""}, and say the businesses confirm final prices when ordering.`,
    `Customer's message: """${message.slice(0, 600)}"""\n\nDATA: ${JSON.stringify(data)}`,
    900,
  )).trim(); llmCalls++;
  } catch (e) { console.warn(`[project] summary wording failed: ${(e as Error).message}`); }
  const allowed = new Set<string>([String(total), ...numbersIn(JSON.stringify(data)), ...numbersIn(message)].map((n) => String(Number(n))));
  let ok = !!msg && numbersIn(msg).every((n) => allowed.has(String(Number(n))));
  // Jev: a priced need must not be presented as "to be priced" (or the reverse).
  const priced = data.filter((d) => d.state === "PRICED").map((d) => d.need);
  if (ok && priced.length) {
    const j = await jevAsk({ message: msg, priced_needs: priced }, Object.fromEntries(priced.map((_, k) => [`p${k}`, { type: "noul", instructions: `Does \`message\` present \`priced_needs[${k}]\` as having a price to pay (not as still to be priced, quoted or confirmed)?` } as JevQuestion])), 5000);
    if (j) ok = priced.every((_, k) => (((j[`p${k}`] as any)?.noul as number) ?? 1) >= 0.5);
    jevCalls++;
  }
  if (!ok) { console.warn("[project] compare summary failed its checks - showing the table"); msg = renderTable(results, total, tbdLines); }

  writes.push(record(async () => {
    await setMemory(project!.id, { results: data, total, tbdLines });
    await addUsage(project!.id, { llmCalls, jevCalls });
    await setStatus(project!.id, "waiting_customer", "system");
  }));
  // Wait for the record at most a few seconds; the answer goes out regardless.
  await Promise.race([Promise.all(writes), new Promise((r) => setTimeout(r, 4000))]);
  return { projectId: project?.id || "", lines: results, total, tbdLines, currency: "PLN", message: msg };
}

/** The comparison as a plain table, built by code (fallback; Polish). */
export function renderTable(results: LineResult[], total: number, tbdLines: number): string {
  const rows = results.map((r) => {
    const q = r.line.quantity !== null ? ` (${r.line.quantity}${r.line.unit !== "unknown" ? ` ${FIELDS.unit.values[r.line.unit].label}` : ""})` : "";
    if (r.status === "not_found") return `• ${r.line.need}${q}: nie znaleziono w sieci - do wyceny`;
    const a = r.assigned!;
    if (r.status === "tbd") return `• ${r.line.need}${q}: ${a.label} - ${a.item}: do wyceny${a.unitPrice !== null ? ` (stawka ${a.unitPrice} zł / ${FIELDS.unit.values[a.unit]?.label || a.unit})` : a.tbd.length ? ` (${a.tbd.join(", ")})` : ""}`;
    return `• ${r.line.need}${q}: ${a.label} - ${a.item}: ${a.total} zł${a.leadTime ? `, ${a.leadTime}` : ""}`;
  });
  return `${rows.join("\n")}\n\nRazem znane pozycje: ${total} zł${tbdLines ? ` + ${tbdLines} poz. do wyceny` : ""}. Ostateczne ceny firmy potwierdzają przy zamówieniu.`;
}
