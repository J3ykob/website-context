/**
 * A business's quoting model (prototype, 2026-10-31): built ONCE from its own pages when it is scraped, run
 * for every question. Replaces the hand-written recipe rules (recipe.ts), whose catalogue of pricing schemes
 * (fixed, per unit, period rates, tiers...) needed new code for every scheme it did not know.
 *
 *   text -> structure (model, once):  the pages become a program - a catalogue (items, their inputs and the
 *                                     business's shared inputs) and two pure functions:
 *                                       needs(request)  -> what is still missing, per line
 *                                       quote(request)  -> per line a price / range / needs / on request,
 *                                                          cross-item rules (packages, minimums, travel), total
 *   verified (model + code):          a second model writes test requests and their expected quotes from
 *                                     the same pages; the program must agree (numbers compared, not text)
 *   text -> structure (model, live):  the customer's message -> a request in the catalogue's terms
 *   structure -> structure (code):    the business's own program computes the quote
 *
 * The program runs in QuickJS (a JavaScript engine compiled to WebAssembly): its own memory, a time limit,
 * nothing but plain JavaScript - the code is written by a model from pages anyone can edit, so it must not
 * reach our process (node:vm is not a security boundary).
 *
 * Large businesses are built in parts (groups of pages, the rules pages - terms, transport - in every part);
 * a quote goes to the part that owns each line. Stored per business with a fingerprint of its pages: rebuilt
 * only when they change.
 */
import { createHash } from "node:crypto";
import { getQuickJS, shouldInterruptAfterDeadline } from "quickjs-emscripten";

export interface InputSpec { name: string; meaning: string; type: "number" | "boolean" | "choice" | "date" | "text"; unit?: string; options?: string[] }
export interface CatalogItem { id: string; name: string; inputs: InputSpec[]; note?: string }
export interface Catalog { business: string; currency: string; shared: InputSpec[]; items: CatalogItem[] }
export interface Request { context: Record<string, unknown>; lines: { item: string; inputs: Record<string, unknown>; need?: string }[] }
export interface QuoteLine { item: string; status: "price" | "range" | "needs" | "on_request" | "not_offered" | "included"; amount?: number; min?: number; max?: number | null; needs?: string[]; note?: string; need?: string; alternative?: boolean }
export interface Quote { lines: QuoteLine[]; total?: { min: number; max: number | null } | null; rules?: string[] }
export interface PricingModel { catalog: Catalog; code: string; source: string; model: string; verified?: { cases: number; agreed: number; problems: string[] } }

export type Llm = (system: string, user: string, maxTokens?: number) => Promise<string>;

/** The first complete JSON value (object) in a model's answer. */
function firstJson(c: string): any {
  const start = c.indexOf("{");
  if (start < 0) throw new Error("no JSON");
  let depth = 0, inStr = false, esc = false;
  for (let k = start; k < c.length; k++) {
    const ch = c[k];
    if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return JSON.parse(c.slice(start, k + 1));
  }
  throw new Error("unfinished JSON");
}
/** The program between the first ``` fence (a model writes it as a code block). */
function codeBlock(c: string): string {
  const a = c.indexOf("```");
  if (a < 0) return c.trim();
  const b = c.indexOf("\n", a), e = c.indexOf("```", b + 1);
  return c.slice(b + 1, e < 0 ? undefined : e).trim();
}

// ── The sandbox ──
const engine = getQuickJS();
/** Runs `fn` of the program on `arg` in QuickJS (32 MB, `ms` time limit); throws on error or timeout. */
export async function run(code: string, fn: "needs" | "quote" | "catalog", arg: unknown, ms = 200): Promise<any> {
  const rt = (await engine).newRuntime();
  rt.setMemoryLimit(32 * 1024 * 1024);
  rt.setMaxStackSize(1024 * 1024);
  rt.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + ms));
  const ctx = rt.newContext();
  try {
    const call = fn === "catalog" ? "catalog" : `${fn}(${JSON.stringify(JSON.parse(JSON.stringify(arg ?? null)))})`;
    const res = ctx.evalCode(`${code}\n;JSON.stringify(${call});`, "pricing.js");
    if (res.error) { const err = ctx.dump(res.error); res.error.dispose(); throw new Error(typeof err === "object" ? `${err?.name || "Error"}: ${err?.message || JSON.stringify(err)}` : String(err)); }
    const out = ctx.getString(res.value);
    res.value.dispose();
    return JSON.parse(out);
  } finally {
    ctx.dispose();
    rt.dispose();
  }
}

// ── Built once, when the business is scraped ──
const GENERATE = `You turn a business's own web pages into its quoting program - how it prices what it offers, as code.
Write ONE JavaScript program (no imports, no I/O, pure functions) that defines:

const catalog = { business, currency, shared: [InputSpec], items: [{ id, name, inputs: [InputSpec], note }] };
  // InputSpec = { name, meaning, type: "number"|"boolean"|"choice"|"date"|"text", unit?, options? }
  // shared = inputs that apply to the whole order (date, venue distance, number of guests...)
  // items = every product or service the pages offer, each with the inputs ITS price needs (none for a fixed price)
function needs(request) -> [{ item, missing: [input names] }]   // what is still missing for each line
function quote(request) -> { lines: [QuoteLine], total, rules }
  // request = { context: {shared input values}, lines: [{ item: id, inputs: {...} }] }
  // QuoteLine = { item, status: "price"|"range"|"needs"|"on_request"|"not_offered"|"included", amount?, min?, max?, needs?, note? }
  // total = { min, max } over priced lines (null when nothing is priced); rules = the rules you applied, short

Rules:
- Encode exactly what the pages state: every price, unit, minimum, tier, package, surcharge, discount, travel or
  delivery charge, and how they combine. Rules that span items (a package replacing single services, a fee
  charged once per order, a minimum order) go in quote().
- A price the pages do not give -> status "on_request". Never invent a price or a typical value.
- status is EXACTLY one of "price", "range", "needs", "on_request", "not_offered", "included" (no other words).
  "included" = its price is part of another item's price (a service inside a package): say which in the note -
  never "price" 0 for that ("price" 0 only when the pages say it is free).
- An input missing from the request: if a price can still be given (the options the customer did not choose,
  each priced) -> status "range" over them; status "needs" (with the input names) ONLY when no price can be given
  without it (e.g. per-guest pricing without the number of guests). Never assume a value.
- A price that holds under a condition the customer did not mention (within 50 km, on weekdays, for up to 100
  guests) -> give that price with the condition in the note; do not withhold it to ask first.
- Where the customer may choose a way of paying (a rate per hour or per day, a weekly rate), quote the cheapest
  for the customer and do not make it an input - the duration is the input. Options that change WHAT is
  bought (a menu, a package, a size) are inputs; if not chosen, give the range over the priced options.
- Several prices with no stated rule for which applies -> status "range".
- One input per quantity, in one unit (a duration is total hours, never days + hours side by side).
- A line may name a NEED instead of an item ({"item": "need", "inputs": {"what": "...", ...}}) or several items that
  could cover it; when packages and single items can both cover what is asked (a package for 5 people vs
  4 single services), quote() picks the cheapest combination that covers it and says so in the note.
Answer with the program in one \`\`\`js code block, nothing else.`;

/** The business's quoting model from the text of its price pages; `feedback` = what a previous version got wrong. */
export async function generate(business: string, pages: { url: string; text: string }[], llm: Llm, model: string, feedback?: { code: string; problems: string[] }): Promise<PricingModel> {
  const source = pages.map((p) => `### ${p.url}\n${p.text}`).join("\n\n").slice(0, 60000);
  const fix = !feedback ? "" : feedback.code
    ? `\n\nA previous version of the program:\n\`\`\`js\n${feedback.code}\n\`\`\`\nIt disagreed with these checks written from the pages - correct the program where the pages support the check:\n- ${feedback.problems.slice(0, 15).join("\n- ")}`
    : `\n\nMake sure of this:\n- ${feedback.problems.slice(0, 30).join("\n- ")}`;
  const code = codeBlock(await llm(GENERATE, `Business: ${business}\n\nIts pages:\n${source}${fix}`, 8000));
  const catalog = (await run(code, "catalog", null)) as Catalog; // read through the sandbox too
  return { catalog, code, source, model };
}

const STATUSES = new Set(["price", "range", "needs", "on_request", "not_offered", "included"]);
/** The interface, checked by code: shapes and status values (structure only). */
function contractProblems(q: any): string[] {
  if (!q || !Array.isArray(q.lines)) return ["quote() must return { lines: [...] }"];
  return q.lines.flatMap((l: any) => !STATUSES.has(l?.status) ? [`status "${l?.status}" is not one of price/range/needs/on_request/not_offered/included`]
    : l.status === "price" && typeof l.amount !== "number" ? [`${l.item}: status price without a numeric amount`]
    : l.status === "range" && typeof l.min !== "number" ? [`${l.item}: status range without a numeric min`] : []);
}

/** Generate -> verify -> regenerate with the disagreements (up to `rounds` more), keeping the best version. */
export async function build(business: string, pages: { url: string; text: string }[], gen: Llm, check: Llm, model: string, rounds = 2, missing: string[] = []): Promise<PricingModel> {
  let best: PricingModel | null = null, feedback: { code: string; problems: string[] } | undefined = missing.length ? { code: "", problems: missing.slice(0, 30).map((n) => `the catalogue leaves out "${n}" - include it if these pages offer it`) } : undefined;
  let cases: any[] | null = null;
  for (let k = 0; k <= rounds; k++) {
    let pm: PricingModel;
    try { pm = await generate(business, pages, gen, model, feedback); } catch (e) { feedback = feedback && { ...feedback, problems: [`the program did not run: ${(e as Error).message.slice(0, 120)}`, ...feedback.problems] }; continue; }
    cases ||= await writeCases(pm, check).catch(() => null); // the same independent checks for every version
    pm = await checkAgainst(pm, cases || []);
    if (!best || (pm.verified!.agreed > best.verified!.agreed)) best = pm;
    if (pm.verified!.problems.length === 0) break;
    feedback = { code: pm.code, problems: pm.verified!.problems };
  }
  if (!best) throw new Error("no program could be built");
  return best;
}

// ── Verified before it is used ──
const CASES = `You check a quoting program. From the business's pages ONLY (not from any program), write test requests and
the quote each must get. Cover: single items, several items in one order, edge values at every boundary the
pages state (tiers, free distance, minimums), a missing input (expected status "needs"), and something the pages
do not price (expected "on_request"). Use the catalogue's item ids and input names.
Answer JSON: {"cases": [{"request": {"context": {}, "lines": [{"item": "...", "inputs": {}}]},
  "expected": {"lines": [{"item": "...", "status": "price|range|needs|on_request|not_offered|included", "amount": 0, "min": 0, "max": 0}], "total": {"min": 0, "max": 0} }, "why": "..."}]}
status is EXACTLY one of those six words ("included" = its price is part of another item's, e.g. inside a package). When the customer does not choose between options the business
prices, expect "range" over them (or "price" when the business takes the cheapest for the customer); expect
"needs" only when no price can be given without the input. 8 to 12 cases.`;

const close = (a?: number | null, b?: number | null) => a == null || b == null ? a == b : Math.abs(a - b) <= Math.max(0.5, Math.abs(b) * 0.005);

/** Test requests and their expected quotes, written from the pages only (never from the program). */
async function writeCases(pm: PricingModel, llm: Llm): Promise<any[]> {
  const j = firstJson(await llm(CASES, `Catalogue:\n${JSON.stringify(pm.catalog)}\n\nPages:\n${pm.source}`, 6000));
  // The checks obey the same interface (a case expecting a status that does not exist checks nothing).
  return (Array.isArray(j?.cases) ? j.cases : []).filter((c: any) => Array.isArray(c?.expected?.lines) && c.expected.lines.every((l: any) => STATUSES.has(l?.status)));
}

/** Program outputs against the cases (structure only: the interface, statuses and numbers). */
async function checkAgainst(pm: PricingModel, cases: any[]): Promise<PricingModel> {
  const problems: string[] = [];
  let agreed = 0;
  for (const c of cases) {
    let got: Quote;
    try { got = (await run(pm.code, "quote", c.request)) as Quote; } catch (e) { problems.push(`${c.why}: program error ${(e as Error).message.slice(0, 80)}`); continue; }
    const bad: string[] = [...contractProblems(got)];
    for (const want of c.expected?.lines || []) {
      const line = got.lines?.find((l) => l.item === want.item);
      if (!line) { bad.push(`${want.item}: missing`); continue; }
      if (want.status && line.status !== want.status) { bad.push(`${want.item}: ${line.status} vs ${want.status}`); continue; }
      if (want.status === "price" && !close(line.amount, want.amount)) bad.push(`${want.item}: ${line.amount} vs ${want.amount}`);
      if (want.status === "range" && (!close(line.min, want.min) || !close(line.max ?? null, want.max ?? null))) bad.push(`${want.item}: ${line.min}-${line.max} vs ${want.min}-${want.max}`);
    }
    if (bad.length) problems.push(`${c.why} -> ${bad.join("; ")}`); else agreed++;
  }
  return { ...pm, verified: { cases: cases.length, agreed, problems } };
}

/** One-shot verification of a given model (kept for callers that build elsewhere). */
export async function verify(pm: PricingModel, llm: Llm): Promise<PricingModel> {
  return checkAgainst(pm, await writeCases(pm, llm));
}

// ── For every question ──
const READ = `You turn a customer's message into a request for this business's quoting program. Use ONLY the catalogue's
item ids and input names. Put an input only when the customer states it or it follows directly ("Saturday and
Sunday" = 2 days, "4x5 m" = 20 m², "the bride and 3 bridesmaids" = 4 people); leave out what they did not say -
never assume. A duration is not a choice of rate ("6 hours" sets the duration, not "pay per hour"); one value
per input in the catalogue's unit ("30 hours over two days" = 30 hours). Every product or service asked for is a
line - for each person or thing the item that is for them (a bridesmaid's make-up is not the bride's). When
several catalogue items (a package, or single services) could cover the same thing, they are OPTIONS of one need -
only the cheapest of them counts. Shared inputs go in "context".
Answer JSON: {"context": {...}, "needs": [{"what": "<what the customer asks for>", "options": [{"item": "<id>", "inputs": {...}}]}]}
({"needs": []} when nothing matches). One need per thing asked; its options are the items that could each cover it.`;

/** The customer's message as a request in the business's terms (text -> structure). */
export async function read(message: string, catalog: Catalog, llm: Llm): Promise<Request> {
  const j = firstJson(await llm(READ, `Catalogue:\n${JSON.stringify(catalog)}\n\nCustomer: ${message}`, 1500));
  // Needs with their options -> lines; the options of one need share its position as their "need" (structure, no text).
  const needs: any[] = Array.isArray(j?.needs) ? j.needs : [];
  const lines = needs.flatMap((n, k) => (Array.isArray(n?.options) ? n.options : []).filter((o: any) => typeof o?.item === "string").map((o: any) => ({ item: o.item, inputs: o.inputs || {}, need: `n${k}` })));
  return { context: j?.context || {}, lines };
}

// ── A whole business: parts, completeness, storage ──
const PART_CHARS = 40000; // page text per part (one generation call)
const MAX_PARTS = () => Number(process.env.PRICING_MAX_PARTS) || 12;
export interface PricingBusiness { tenantId: string; hash: string; builtAt: string; model: string; parts: PricingModel[]; costUsd: number; missing: string[]; failed?: string[] }

/** The generation model with reasoning on (one-off per business; OpenRouter, pinned to the model's maker). */
export function reasonedLlm(model: string, usage?: { usd: number }): Llm {
  return async (system, user, maxTokens = 8000) => {
    const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal: AbortSignal.timeout(300_000),
      headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: maxTokens + 12000, reasoning: { max_tokens: 12000 }, usage: { include: true }, provider: { order: ["anthropic"], allow_fallbacks: true }, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
    });
    const j: any = await r.json();
    if (!r.ok) throw new Error(`OpenRouter ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    if (usage && typeof j?.usage?.cost === "number") usage.usd += j.usage.cost;
    return String(j?.choices?.[0]?.message?.content || "");
  };
}

/** Offer items the catalogue leaves out - judged by a model (names differ in wording; code never matches text). */
async function missingFromCatalog(catalog: Catalog, offer: string[], llm: Llm): Promise<string[]> {
  if (!offer.length) return [];
  const j = firstJson(await llm("You compare two lists of a business's products and services. Output only JSON.",
    // Items with their inputs' options: a flavour or size offered as an option of an item is covered (Liliowa's
    // 12 cake flavours were flagged as missing products and sent the build round after nothing).
    `Catalogue (a program's items, with the options of their inputs):\n${catalog.items.map((i) => `- ${i.name}${(i.inputs || []).filter((x) => x.options?.length).map((x) => ` [${x.name}: ${x.options!.join(", ")}]`).join("")}${i.note ? ` - ${i.note.slice(0, 300)}` : ""}`).join("\n")}\n\nOffer items read from the same pages:\n${offer.map((n, k) => `${k}: ${n}`).join("\n")}\n\nWhich offer items have NO counterpart in the catalogue - neither an item (the same product or service under any name) nor one of an item's options, nor named in an item's note as a variant of it (e.g. a flavour)? {"missing": [numbers]}`, 2000));
  return (Array.isArray(j?.missing) ? j.missing : []).filter((k: unknown) => Number.isInteger(k) && offer[k as number]).map((k: number) => offer[k]);
}

/** Pages into parts of at most PART_CHARS, each with the business's rules pages (terms that apply to all). */
function partsOf(pages: { url: string; text: string }[], rules: Set<string>): { url: string; text: string }[][] {
  const shared = pages.filter((p) => rules.has(p.url)), own = pages.filter((p) => !rules.has(p.url));
  const base = shared.reduce((n, p) => n + p.text.length, 0);
  const parts: { url: string; text: string }[][] = [];
  let cur: typeof own = [], size = base;
  for (const p of own) {
    if (cur.length && size + p.text.length > PART_CHARS) { parts.push([...shared, ...cur]); cur = []; size = base; }
    cur.push(p); size += p.text.length;
  }
  if (cur.length || !parts.length) parts.push([...shared, ...cur]);
  return parts.slice(0, MAX_PARTS());
}

/** The business's quoting model, built once from its offer pages (and its extracted items for completeness). */
export async function buildBusiness(tenantId: string, business: string, pages: { url: string; text: string }[], offerNames: string[], model = process.env.PRICING_MODEL || "anthropic/claude-opus-5.5", llms?: { gen: Llm; check: Llm }): Promise<PricingBusiness> {
  const usage = { usd: 0 };
  const llm = llms?.gen || reasonedLlm(model, usage);
  const hash = createHash("sha1").update(`${model}\n${pages.map((p) => `${p.url}\n${p.text}`).join("\n")}`).digest("hex");
  // Rules pages (terms, delivery, deposits, discounts that apply to every offer) go into every part.
  const { jevAsk } = await import("../llm/jev.js");
  const rj = pages.length > 1 ? await jevAsk({ pages: pages.map((p) => `${p.url} - ${p.text.slice(0, 300)}`) }, Object.fromEntries(pages.map((_, k) => [`r${k}`, { type: "noul" as const, instructions: `Is \`pages[${k}]\` about terms that apply to all of the business's offers (rental or order conditions, delivery, deposits, discounts, minimums) rather than particular products?` }])), 15000).catch(() => null) : null;
  const rules = new Set(pages.filter((_, k) => ((((rj as any)?.[`r${k}`]?.noul) as number) ?? 0) >= 0.5).map((p) => p.url));
  const built: PricingModel[] = [], failed: string[] = [];
  for (const part of partsOf(pages, rules)) {
    const pm = await build(business, part, llm, llm, model).catch((e) => { failed.push((e as Error).message.slice(0, 200)); console.warn(`[pricing] ${tenantId}: a part failed - ${(e as Error).message}`); return null; });
    if (pm) built.push(pm);
  }
  // Completeness: offer items no part covers, judged by a cheaper model; those parts are rebuilt once with the gap named.
  const cheap = llms?.check || reasonedLlm(process.env.PRICING_CHECK_MODEL || "anthropic/claude-sonnet-5.5", usage);
  const all: Catalog = { business, currency: "PLN", shared: [], items: built.flatMap((p) => p.catalog.items || []) };
  let missing = await missingFromCatalog(all, offerNames.slice(0, 300), cheap).catch(() => [] as string[]);
  if (missing.length) {
    for (let k = 0; k < built.length; k++) {
      const again = await build(business, partsOf(pages, rules)[k], llm, llm, model, 1, missing).catch(() => null);
      if (again && again.catalog.items.length > built[k].catalog.items.length && again.verified!.agreed >= built[k].verified!.agreed) built[k] = again;
    }
    missing = await missingFromCatalog({ ...all, items: built.flatMap((p) => p.catalog.items || []) }, offerNames.slice(0, 300), cheap).catch(() => missing);
  }
  console.log(`[pricing] ${tenantId}: ${built.length} part(s), ${built.reduce((n, p) => n + p.catalog.items.length, 0)} items, checks ${built.reduce((n, p) => n + (p.verified?.agreed || 0), 0)}/${built.reduce((n, p) => n + (p.verified?.cases || 0), 0)}, missing ${missing.length}, $${usage.usd.toFixed(2)}`);
  return { tenantId, hash, builtAt: new Date().toISOString(), model, parts: built, costUsd: usage.usd, missing, failed };
}

/**
 * A quote over every part: each line goes to the part whose catalogue has its item (the first part that has
 * it - an item found on two pages is quoted once). Lines sharing a "need" are alternatives for one thing: only
 * the cheapest priced one counts in the total, the others are listed as alternatives (a make-up package and
 * the single services it replaces were added up: 6045 zł instead of 2545).
 */
export async function quoteBusiness(pb: PricingBusiness, request: Request): Promise<Quote> {
  const lines: QuoteLine[] = [], rules: string[] = [];
  const owner = (id: string) => pb.parts.findIndex((p) => p.catalog.items.some((i) => i.id === id));
  for (let k = 0; k < pb.parts.length; k++) {
    const own = request.lines.filter((l) => owner(l.item) === k);
    if (!own.length) continue;
    const q = (await run(pb.parts[k].code, "quote", { context: request.context, lines: own.map(({ item, inputs }) => ({ item, inputs })) }).catch((e) => ({ lines: own.map((l) => ({ item: l.item, status: "on_request", note: `could not compute: ${(e as Error).message.slice(0, 60)}` })) }))) as Quote;
    for (const l of q.lines || []) lines.push({ ...l, need: own.find((x) => x.item === l.item)?.need });
    rules.push(...(q.rules || []));
  }
  for (const l of request.lines) if (!lines.some((x) => x.item === l.item)) lines.push({ item: l.item, status: "not_offered", need: l.need });
  // One line per need in the total: the cheapest priced alternative (by its lower amount).
  const low = (l: QuoteLine) => (l.status === "price" ? l.amount! : l.status === "range" ? l.min! : Infinity);
  const groups = new Map<string, QuoteLine[]>();
  lines.forEach((l, k) => { const key = l.need || `#${k}`; groups.set(key, [...(groups.get(key) || []), l]); });
  const counted: QuoteLine[] = [];
  for (const g of groups.values()) {
    const best = g.filter((l) => low(l) < Infinity).sort((a, b) => low(a) - low(b))[0];
    if (best) counted.push(best);
    if (g.length > 1) for (const l of g) if (l !== best) l.alternative = true;
  }
  const total = counted.length ? { min: counted.reduce((n, l) => n + low(l), 0), max: counted.some((l) => l.status === "range" && l.max == null) ? null : counted.reduce((n, l) => n + (l.status === "price" ? l.amount! : l.max!), 0) } : null;
  return { lines, total, rules };
}

/** The catalogue of all parts (what the reader maps a message onto). */
export const catalogOf = (pb: PricingBusiness): Catalog => ({ business: pb.parts[0]?.catalog.business || pb.tenantId, currency: pb.parts[0]?.catalog.currency || "PLN", shared: pb.parts.flatMap((p) => p.catalog.shared || []), items: pb.parts.flatMap((p) => p.catalog.items || []) });

const KEY = (tenantId: string) => `tenants/${tenantId}/pricing.json`;
export async function savePricing(pb: PricingBusiness): Promise<void> {
  const { uploadToR2 } = await import("../storage/r2.js");
  await uploadToR2(KEY(pb.tenantId), JSON.stringify(pb), "application/json");
}
export async function loadPricing(tenantId: string): Promise<PricingBusiness | null> {
  const { downloadFromR2 } = await import("../storage/r2.js");
  return downloadFromR2(KEY(tenantId)).then((b) => (b ? JSON.parse(b.toString("utf-8")) : null)).catch(() => null);
}

/**
 * A conversation priced by a business's quoting model, as fact lines for a reply or an agent: the request
 * read in the model's terms (Haiku), its program quotes it. null = nothing in its catalogue was asked.
 */
export async function quoteText(pb: PricingBusiness, convo: string): Promise<string | null> {
  const catalog = catalogOf(pb);
  const { OpenRouterProvider } = await import("../llm/openrouter-provider.js");
  const or = new OpenRouterProvider({ model: "anthropic/claude-haiku-5.5", maxTokens: 1500, temperature: 0 });
  const request = await read(convo, catalog, async (sys, user, max = 1500) => (await or.chat([{ role: "system", content: sys }, { role: "user", content: user }], { maxTokens: max })).content);
  if (!request.lines.length) return null;
  const q = await quoteBusiness(pb, request);
  const name = (id: string) => catalog.items.find((i) => i.id === id)?.name || id;
  const zl = (n: number) => `${Math.round(n * 100) / 100} ${catalog.currency || "PLN"}`;
  const lines = q.lines.map((l) => `- ${name(l.item)}${l.alternative ? " (an alternative - not in the total)" : ""}: ${l.status === "price" ? zl(l.amount!) : l.status === "range" ? `${zl(l.min!)}${l.max != null ? ` - ${zl(l.max)}` : " or more"}` : l.status === "needs" ? `needs: ${(l.needs || []).join(", ")} (ask the customer)` : l.status === "on_request" ? "price on request" : l.status === "included" ? "included in another item's price" : "not in our offer"}${l.note ? ` (${l.note})` : ""}`);
  if (q.total) lines.push(`Total (the cheapest option for each thing asked): ${zl(q.total.min)}${q.total.max != null && q.total.max !== q.total.min ? ` - ${zl(q.total.max)}` : ""}`);
  return lines.join("\n");
}
