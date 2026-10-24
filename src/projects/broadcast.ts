/**
 * The network answers a customer's request: the request is split into parts (neutral wording, no personal
 * data - only the parts leave the project), broadcast to every business of the network, and each business
 * answers from its own data: for each part an offer - precise (a price from its price list for what was
 * asked) or vague (it does this, price to agree) - or nothing. Then, per part, Jev picks the best answer
 * with the customer's context, three rounds, each without the ones already picked. The picked offers are
 * the network's input to the customer's project (the compiling agent works from them).
 *
 * A business with a price list answers with its own offer shortlist and one model call; one that has
 * nothing for the request in its offer declines without a call. A business without a price list is judged
 * by Jev from its description - one call per part for all of them, no model call per business (that grew
 * with the network: every member cost a call). Arithmetic in the offers is not trusted - the agent recomputes.
 */
import type { OfferItem } from "../offer/store.js";

const MODEL = () => process.env.NETWORK_MODEL || "deepseek/deepseek-v4.1-flash";
const TO_JEV = 50; // answers per part given to Jev
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
        body: JSON.stringify({ model: MODEL(), temperature: 0, max_tokens: maxTokens, response_format: { type: "json_object" }, provider: { sort: "throughput" }, reasoning: { enabled: false },
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
  const j = await llmJson(SPLIT, need.slice(0, 3000), 800);
  return (Array.isArray(j?.parts) ? j.parts : []).filter((p: unknown): p is string => typeof p === "string" && p.trim().length > 2).map((p: string) => p.trim().slice(0, 300)).slice(0, MAX_PARTS);
}

const ANSWER = `Odpowiadasz w imieniu firmy na zapytanie z sieci firm: klient innej firmy potrzebuje rzeczy wymienionych
w częściach. Masz pozycje oferty tej firmy dopasowane do zapytania (z cenami) i jej opis. Dla każdej części, którą
firma ma w ofercie, przygotuj ofertę:
- precyzyjną ("precise": true), gdy cennik podaje cenę, którą da się zastosować do ilości i czasu z części - podaj
  pozycję, stawkę i wynik;
- ogólną ("precise": false), gdy firma to robi lub sprzedaje, ale ceny nie ma albo nie da się jej zastosować -
  napisz, co firma oferuje, i że cena do ustalenia.
Odpowiadaj tylko na części, które firma SAMA wprost oferuje (nazwane w jej pozycjach albo w opisie) - nie
"może obejmować", nie ogólne "usługi budowlane / remontowe" przy konkretnej rzeczy, nie zamiennik innego rodzaju.
W razie wątpliwości pomiń część. Nie wymyślaj cen ani pozycji - tylko z danych; ceny z artykułów i poradników
(orientacyjne ceny rynkowe) to nie ceny firmy. Gdy firma nie ma nic: {"offers": []}.
JSON: {"offers": [{"part": <numer części>, "precise": true|false, "text": "1-3 zdania", "items": ["id pozycji"]}]}`;

/** One business's answer: its offers per part (none = it declines). */
async function answerAs(tenantId: string, parts: string[], items: OfferItem[], about: string, label: string): Promise<NetworkOffer[]> {
  const { renderItem } = await import("../offer/store.js");
  const list = items.map((i) => `id ${i.id.slice(0, 8)} | ${renderItem(i).slice(0, 400)}`).join("\n");
  const user = `Firma: ${label}\nOpis firmy: ${about.slice(0, 600) || "(brak)"}\n\nCzęści zapytania:\n${parts.map((p, k) => `${k + 1}. ${p}`).join("\n")}\n\nPozycje oferty firmy:\n${list || "(brak cennika - tylko opis firmy)"}`;
  const j = await llmJson(ANSWER, user);
  const byId = new Map(items.map((i) => [i.id.slice(0, 8), i]));
  return (Array.isArray(j?.offers) ? j.offers : []).flatMap((o: any) => {
    const part = Number(o?.part) - 1;
    const text = typeof o?.text === "string" ? o.text.trim().slice(0, 600) : "";
    if (!(part >= 0 && part < parts.length) || !text) return [];
    const its = (Array.isArray(o?.items) ? o.items : []).map((x: unknown) => byId.get(String(x))).filter(Boolean) as OfferItem[];
    return [{ tenantId, part, precise: o?.precise === true && its.length > 0, text, items: its }];
  });
}

/**
 * Jev picks the best answers for one part, one at a time (each round without the ones already picked),
 * judging with the customer's whole request as context.
 */
async function pickBest(need: string, part: string, answers: NetworkOffer[], labelOf: (id: string) => string): Promise<NetworkOffer[]> {
  const { jevAsk } = await import("../llm/jev.js");
  let pool = answers.slice(0, TO_JEV);
  const picked: NetworkOffer[] = [];
  while (pool.length && picked.length < PICKS) {
    if (pool.length === 1) { picked.push(pool[0]); break; }
    const criteria = Object.fromEntries(pool.map((o, k) => [`o${k}`, `${labelOf(o.tenantId)} (${o.precise ? "cena z cennika" : "cena do ustalenia"}): ${o.text}`]));
    const a = await jevAsk({ customer_request: need.slice(0, 2500), part_to_supply: part }, {
      best: { type: "choice", instructions: "Which offer best gives the customer `part_to_supply` - exactly what was asked (the right product or service, quantity and time), with a concrete price when there is one? Judge only the offers.", criteria },
    }, 8000);
    const key = (a?.best as any)?.choice as string | undefined;
    const k = key ? Number(key.slice(1)) : NaN;
    const choice = Number.isInteger(k) && pool[k] ? pool[k] : pool[0]; // Jev down: the first (most specific) answer
    picked.push(choice);
    pool = pool.filter((o) => o !== choice);
  }
  return picked;
}

/**
 * Businesses without a price list: Jev judges, per part, whether each one's own description shows it
 * offers that (one call per part for all of them). Those that do get a vague offer from their own words
 * - "it does this, price to agree" - with no model call.
 */
async function describedOffers(parts: string[], ids: string[], about: (id: string) => string, label: (id: string) => string): Promise<NetworkOffer[]> {
  if (!ids.length) return [];
  const { jevBusinessesOffer } = await import("../llm/jev.js");
  const out: NetworkOffer[] = [];
  await Promise.all(parts.map(async (part, k) => {
    const scores = await jevBusinessesOffer(part, ids.map((id) => ({ name: label(id), passages: [about(id).slice(0, 900)] }))).catch(() => null);
    if (!scores) return;
    ids.forEach((id, i) => {
      if (scores[i] >= 0.5) out.push({ tenantId: id, part: k, precise: false, text: `${label(id)}: ${about(id).replace(/\s+/g, " ").slice(0, 300)} (cena do ustalenia)`, items: [] });
    });
  }));
  return out;
}

/**
 * The whole round: split, broadcast, pick. tenantIds: the network (the business running the project
 * included - its offer competes like any other). Never throws: a failure means no network offers.
 */
export async function broadcastNeed(need: string, tenantIds: string[], ownFirst?: string): Promise<Broadcast> {
  const t0 = Date.now();
  const parts = await splitNeed(need).catch(() => [] as string[]);
  if (!parts.length) return { parts, answered: 0, declined: tenantIds.length, picked: [], ms: Date.now() - t0 };
  const { loadOffer } = await import("../offer/store.js");
  const { offerMatches, networkMembers, businessLabel } = await import("./network.js");
  const members = new Map((await networkMembers(tenantIds[0]).catch(() => [])).map((m) => [m.tenantId, m]));
  const query = parts.join("\n");
  const offers = new Map(await Promise.all(tenantIds.map(async (id) => [id, (await loadOffer(id).catch(() => null))?.items || []] as const)));
  const answersOf = async (ids: string[]): Promise<NetworkOffer[]> => {
    const withList = ids.filter((id) => offers.get(id)!.length);
    const withoutList = ids.filter((id) => !offers.get(id)!.length && (members.get(id)?.about || "").trim());
    return [
      ...(await Promise.all(withList.map(async (id) => {
        const all = offers.get(id)!;
        // Its offer has nothing for the request: it declines without a model call.
        const matched = await offerMatches(id, all, query).catch(() => null);
        if (matched !== null && !matched.length) return [];
        return answerAs(id, parts, matched ?? all.slice(0, 15), members.get(id)?.about || "", businessLabel(id)).catch(() => [] as NetworkOffer[]);
      }))).flat(),
      ...(await describedOffers(parts, withoutList, (id) => members.get(id)?.about || "", businessLabel)),
    ];
  };
  // The business running the project first: when its own price list has a priced offer for every
  // part, the network is not asked at all (Rentbud pricing its own machines asked 15 others).
  let answers: NetworkOffer[];
  if (ownFirst && tenantIds.includes(ownFirst) && offers.get(ownFirst)?.length) {
    const mine = await answersOf([ownFirst]);
    const covered = parts.every((_, k) => mine.some((a) => a.part === k && a.precise));
    answers = covered ? mine : [...mine, ...(await answersOf(tenantIds.filter((id) => id !== ownFirst)))];
  } else answers = await answersOf(tenantIds);
  const answeredBy = new Set(answers.map((a) => a.tenantId));
  // Per part: precise offers first, then the vague ones - so the 50 given to Jev keep the concrete ones.
  const picked = (await Promise.all(parts.map((p, k) => pickBest(need, p,
    answers.filter((a) => a.part === k).sort((x, y) => Number(y.precise) - Number(x.precise)), businessLabel)))).flat();
  return { parts, answered: answeredBy.size, declined: tenantIds.length - answeredBy.size, picked, ms: Date.now() - t0 };
}
