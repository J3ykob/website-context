import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { AsyncLocalStorage } from "node:async_hooks";
import type { ChatMessage } from "../src/llm/chat.js";
import type { TenantManager } from "../src/multi-tenant/tenant-manager.js";

// Live, the whole chain on real data: 20 realistic customer messages to Rentbud (network
// "warszawa-budowlanka") - vague, typos, implied quantities, several businesses, products nobody has,
// prices on request, personal data, PL/EN/UK/FR. Each goes through the real pipeline: the chat routes it,
// the need is advertised to the network, the project agent works from what the businesses claimed and
// asks them for the rest, their agents answer, the customer gets one reply (the test approves it as
// Rentbud's owner would). A judge model grades the reply against expert ground truth and the real price
// rows; every non-correct verdict must be read by a person (the judge errs both ways).
// Run on the VPS (tests/run.sh); CHAIN_CASES=C1,C9 runs a subset. Costs ~$1, 40-60 min for all 20.
const live = process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET && process.env.JEV_API_KEY && process.env.CF_API_TOKEN && process.env.OPENROUTER_API_KEY ? describe : describe.skip;
// CHAIN_SET=wesela: the wedding network (Warsaw, 14 businesses) instead of construction - pricing that
// looks nothing like construction (per guest by guest count, per kg with a minimum, packages + hours, travel).
const SET = process.env.CHAIN_SET || "budowlanka";
const TENANT = SET === "wesela" ? "sosnowydwor_com_pl" : "www_rentbud_pl";
const JUDGE = "qwen/qwen3-235b-a22b-2507";
const run = `test-chain-${Date.now()}`;
const AT_ONCE = Number(process.env.CHAIN_AT_ONCE) || 4; // the test machines drop connections in bigger bursts

// must: numbers the reply has to contain, checked by code (each inner list = acceptable alternatives) -
// the deterministic half of the verdict (docs/noise-plan.md #7); the LLM judge runs 3 times, majority.
type Case = { id: string; msg: string; truth: string; rows: [string, string[]][]; must?: number[][] };
const BUDOWLANKA: Case[] = [
  { id: "C1", msg: "Cześć, muszę ubić podjazd przed domem, jakieś 60 m2, robię to w ten weekend (sobota i niedziela). Co polecacie i ile to wyjdzie?", truth: "Rentbud: a plate compactor (zagęszczarka; any reasonable one) for 2 days = 2 × its daily rate (e.g. 130 kg: 280 zł, 150 kg: 340 zł). The price must match the chosen item's daily rate. Concrete is not asked for.", rows: [["www_rentbud_pl", ["zagęszczarka", "ubijak"]]], must: [[280, 340]] },
  { id: "C2", msg: "ile za wibrator do betonu od piątku rana do poniedziałku rana?", truth: "Rentbud: Wibrator do betonu 4m, 3 days × 90 zł = 270 zł (hourly would be 72 h × 18 = 1296, worse).", rows: [["www_rentbud_pl", ["wibrator"]]], must: [[270]] },
  { id: "C3", msg: "potrzebuje frezarke do betonu na pół dnia, ile to kosztuje", truth: "Rentbud (site as of 2026-10-30): Frezarka do betonu FB200 (76 zł/hour or 380 zł/day) and FB300 (104 zł/hour or 520 zł/day). 'Half a day' is ambiguous: correct = prices consistent with these rates for a stated assumption (hours or one day), or the rates explained. Wrong = any other price.", rows: [["www_rentbud_pl", ["frezarka"]]] },
  { id: "C4", msg: "Hi, we're renovating a 4x5 m room and want the vinyl flooring in beige coast oak, plus whatever glue it needs. How much would that be?", truth: "Romax (offer as of 2026-10-30): no beige coast oak vinyl is listed; its vinyl panel (Amber Canyon Virtus SPC) has no price -> to be quoted. Glue: Bautec Multi TEC (LVT) 403 zł/pc (TEC SPU 779 zł is for hybrid floors); how many pieces for 20 m² is not in the data -> to confirm. Correct = says the exact colour isn't listed / flooring needs a quote, glue price right; an invented flooring price = wrong. Reply in English.", rows: [["www_romax_waw_pl", ["winyl", "spc", "bautec"]]], must: [[403]] },
  { id: "C5", msg: "Добрий день, скільки коштуватиме оренда фасадного риштування на 2 тижні для приватного будинку?", truth: "OSTAP rents facade scaffolding with no rental price in the data; Rentbud lists per-element/per-m² scaffolding rates (e.g. Rusztowanie klinowe Rubo). Without the house size no total is possible: correct = rates quoted as rates and a quote/size needed. A price per element (or per m²) for the rental period is fine; a total for the house without its size = wrong. Reply in Ukrainian.", rows: [["www_ostap_pl", ["rusztow"]], ["www_rentbud_pl", ["rusztow"]]] },
  { id: "C6", msg: "Bonjour, je cherche une mini-pelle pour une journée, c'est combien ?", truth: "No mini-excavator in the network data. Rentbud has only 'Koparka do nawodnień' (chain trencher TRENCH ZK40, 450 zł/day) - it may be offered as an alternative only if clearly described as a trencher, not as a mini-pelle. Reply in French.", rows: [["www_rentbud_pl", ["koparka"]]] },
  { id: "C7", msg: "Robię taras 3 na 4 metry, wylewka ok. 10 cm. Potrzebuję betonu, wibratora do betonu na jeden dzień i zacieraczki. Ile całość?", truth: "Concrete ~1,2 m³ (3×4×0,1): concrete firms (BUDOMAT ŁAZY, bostabeton) have no price -> individual quote. Rentbud: vibrator 1 day 90 zł; trowel (zacieraczka) 1 day 120 zł (disc only) or 240 zł (disc + blades). Priced parts 210 or 330 zł plus concrete to be quoted. A total with an invented concrete price = wrong.", rows: [["www_rentbud_pl", ["wibrator", "zacieraczka"]], ["beton_lazy_pl", ["beton"]]], must: [[90], [120, 240]] },
  { id: "C8", msg: "jaki koszt tynku cienkowarstwowego na dom, ściany mają razem jakieś 200 metrów", truth: "KH-Bud: Tynk cienkowarstwowy 70-110 zł/m² × 200 m² = 14000-22000 zł.", rows: [["kh_bud_pl", ["tynk"]]], must: [[14000], [22000]] },
  { id: "C9", msg: "chcę kupić 15 kozłów budowlanych, najtańszych jakie macie", truth: "OSTAP: the cheapest trestle in its price list is Kozioł MINI 240 zł/pc (net, from its 2011 price list) -> 15 x 240 = 3600 zł; other models B-BR 350, B-SK 455, B-S 520 zł. Rentbud itself does not sell trestles. Mentioning that the list may be dated is a plus, not required.", rows: [["www_ostap_pl", ["kozioł"]]], must: [[3600]] },
  { id: "C10", msg: "potrzebuję kleju do paneli winylowych, 3 wiadra, ile zapłacę?", truth: "Romax: Bautec Multi TEC klej do LVT 14 kg 403 zł × 3 = 1209 zł (preferred: it is for vinyl/LVT). TEC SPU 779 zł × 3 = 2337 zł is for hybrid floors - acceptable only as a clearly labelled alternative.", rows: [["www_romax_waw_pl", ["klej", "bautec"]]], must: [[1209]] },
  { id: "C11", msg: "Ile za wymianę rynien i obróbek blacharskich na dachu? Dom 10x12 m.", truth: "Perfekt Dach: both 'Montaż i naprawa rynien' and 'Wymiana obróbek blacharskich' are price on request -> individual quote. Any concrete price = wrong.", rows: [["www_dachywarszawa_pl", ["rynien", "obróbek"]]] },
  { id: "C12", msg: "Zagęszczarka 130 kg na 5 godzin, a jakbym wziął na całą dobę to ile?", truth: "Rentbud: 5 h × 28 = 140 zł; one day = 140 zł. Both 140 zł.", rows: [["www_rentbud_pl", ["zagęszczarka 130"]]], must: [[140]] },
  { id: "C13", msg: "Wiertnica do otworów 150 mm na 3 dni, plus korona do niej", truth: "Rentbud: Wiertnica do max. śr. 152 mm, 3 days × 160 = 480 zł. A core bit (korona) is not in the data -> to confirm / quote.", rows: [["www_rentbud_pl", ["wiertnica", "korona"]]], must: [[480]] },
  { id: "C14", msg: "Need a sludge pump for about 30 hours over the next two days, what's the cost?", truth: "Rentbud: Motopompa szlamowa 2 days × 140 = 280 zł (hourly 30 × 28 = 840 is worse). Reply in English.", rows: [["www_rentbud_pl", ["motopompa"]]], must: [[280]] },
  { id: "C15", msg: "Wynajem 2 zagęszczarek 130 kg na tydzień - ile?", truth: "Rentbud: 2 × 7 days × 140 = 1960 zł.", rows: [["www_rentbud_pl", ["zagęszczarka 130"]]], must: [[1960]] },
  { id: "C16", msg: "podłoga winylowa szara 25 m2 i grunt pod nią", truth: "Romax (offer as of 2026-10-30): no grey vinyl floor with a price - the vinyl panel Amber Canyon Virtus SPC is unpriced (to be quoted); grey SPC mineral boards (Płyta Mineralna SPC Zenith Grey 139 zł/m², 25 m² = 3475 zł) are acceptable only if clearly named as what they are. Primer Bautec TEC PRIMER D 5 kg 239 zł/pc, quantity not in data -> to confirm (an assumed number of packs = partial). Saying the grey vinyl must be quoted is CORRECT. A laminate (Akacja szara) presented as vinyl = wrong.", rows: [["www_romax_waw_pl", ["winyl", "spc", "primer"]]], must: [[239]] },
  { id: "C17", msg: "Dzień dobry, tu Anna Kowalska z Ząbek, tel. 600 111 222. Robimy remont łazienki i kuchni. Ile by kosztował remont łazienki około 6 m2?", truth: "Renovation firms (e.g. RUTAS 'Remonty łazienek') are price on request -> individual quote. Any concrete price = wrong.", rows: [["rutas_pl", ["łazien"]]] },
  { id: "C18", msg: "macie zacieraczkę z łopatkami na 2 doby?", truth: "Rentbud: zacieraczka with disc + blades ('Talerz + łopatki') 240 zł/day × 2 = 480 zł (230V Ø600 or petrol Ø1000).", rows: [["www_rentbud_pl", ["zacieraczka"]]], must: [[480]] },
  { id: "C19", msg: "Potrzebuję wykopać rów pod drenaż, ok. 25 m, jakąś maszyną na 6 godzin. Ile to kosztuje?", truth: "Rentbud: Koparka do nawodnień (trencher) - 6 h hourly 540 vs daily 450 -> 450 zł (540 as the price without the cheaper daily rate = wrong).", rows: [["www_rentbud_pl", ["koparka"]]], must: [[450]] },
  { id: "C20", msg: "Потрібно 5 м3 бетону з доставкою на завтра, скільки це коштує?", truth: "Concrete firms (BUDOMAT ŁAZY, bostabeton) have no prices -> individual quote, delivery date to confirm. Any concrete price = wrong. Reply in Ukrainian.", rows: [["beton_lazy_pl", ["beton"]]] },
];
// Truths from the businesses' own price pages (2026-10-30). The asking business is the venue Sosnowy Dwór.
const WESELA: Case[] = [
  { id: "W1", msg: "Planujemy wesele na 90 osób w sobotę w czerwcu. Ile wyniesie samo przyjęcie u Was?", truth: "Sosnowy Dwór: wedding reception (I propozycja) per guest by guest count - 80-99 guests: 205 zł/person -> 90 x 205 = 18450 zł. Extras (service staff meals, rooms, country table) are separate and optional.", rows: [["sosnowydwor_com_pl", ["wesel", "przyjęcie"]]], must: [[18450]] },
  { id: "W2", msg: "Wesele na 120 osób, potrzebujemy też tortu (ok. 12 kg) i bukietu dla panny młodej. Ile to wszystko?", truth: "Sosnowy Dwór: 100+ guests 200 zł/person -> 24000 zł. Cake from the network: Sweet Home wedding cakes 140-180 zł/kg with minimum weights (e.g. 12 kg x 180 = 2160 zł for its 'Tort weselny'), Liliowa 130-170 zł/kg. Bouquet: Kwiaciarnia Miłość from ~230-250 zł, Floli from 285 zł. A total is fine only if each part's price is stated; a single invented total = wrong.", rows: [["sosnowydwor_com_pl", ["wesel"]], ["sweet_home_pl", ["tort"]], ["liliowa_pl", ["tort"]], ["kwiaciarniamilosc_pl", ["bukiet"]], ["floli_pl", ["bukiet"]]], must: [[24000]] },
  { id: "W3", msg: "Szukamy fotografa na 8 godzin, jak najtaniej. Co możecie polecić?", truth: "Zając Foto: Pakiet Ekonomiczny 3500 zł for 6 h + 500 zł per extra hour -> 8 h = 4500 zł (cheapest covering 8 h); Pakiet Standardowy 5000 zł covers the whole day. Kamil Kozielewicz: reportaż klasyczny 9 h 5700 zł, krótki 5 h 3700 zł (too short). The venue does not do photography itself.", rows: [["zajacfoto_com", ["pakiet"]], ["kamilkozielewicz_pl", ["reportaż"]]], must: [[4500]] },
  { id: "W4", msg: "Potrzebuję DJ-a na wesele i nagłośnienia ślubu cywilnego w plenerze. Ile to kosztuje?", truth: "Pełny Parkiet: DJ + host package 5500 zł (10 h, sound, lights, travel up to 50 km) + civil ceremony sound 600 zł = 6100 zł. DJ MW: weddings from about 3300 to 6500 zł (package dependent). Either is fine with correct prices.", rows: [["pelnyparkiet_pl", ["wesel", "ślub"]], ["djmw_pl", ["wesel"]]], must: [[5500, 6100, 3300]] },
  { id: "W5", msg: "Hi, the bride and 3 bridesmaids need make-up on the wedding day, the venue is about 45 km from Warsaw. How much?", truth: "Ania Tkaczyk: Pakiet Komfort 2500 zł (5 services, travel included up to 30 km; beyond 30 km 3 zł/km) or bridal make-up 400-500 zł per person; Angelika Solecka: make-up 350 zł per person, travel outside Warsaw priced individually. Reply in English; travel cost beyond the free radius must not be invented beyond the stated rate.", rows: [["aniatkaczyk_pl", ["makijaż", "pakiet"]], ["angelikasolecka_pl", ["makijaż"]]] },
  { id: "W6", msg: "Скільки коштує весільний торт на 100 гостей?", truth: "Sweet Home: about 1 kg per 8-10 people -> 10-12.5 kg; wedding cakes 140-180 zł/kg with minimum weights. Liliowa: 3-tier ~10 kg for ~100 portions, 130-170 zł/kg. The venue itself does not sell cakes. Reply in Ukrainian.", rows: [["sweet_home_pl", ["tort"]], ["liliowa_pl", ["tort"]]] },
  { id: "W7", msg: "Ile kosztuje udekorowanie kościoła i sali kwiatami na wesele?", truth: "Full wedding floral decoration is priced individually (Kwiaciarnia Miłość: typically 3000-10000 zł depending on guests and arrangements - only if its pages say so); bouquets have prices. Any single invented total = wrong.", rows: [["kwiaciarniamilosc_pl", ["dekorac", "bukiet"]], ["floli_pl", ["dekorac"]]] },
  { id: "W8", msg: "Czy możemy przyjść z własnym tortem i ile to kosztuje dodatkowo?", truth: "Answer only from Sosnowy Dwór's own pages (own cake / cake fee) - if its pages do not state it, say so; do not invent a fee.", rows: [["sosnowydwor_com_pl", ["tort"]]] },
];
const CASES: Case[] = SET === "wesela" ? WESELA : BUDOWLANKA;
const PII = ["Kowalsk", "600 111 222", "600111222"];

const JUDGE_SYS = `You grade a reply a customer received. You get the customer's message, the ground truth written by an expert,
the relevant rows of the businesses' real price lists, and the reply. Judge only facts: products, prices, totals, what was
flagged as needing a quote, language. Return JSON {"verdict": "correct" | "partial" | "wrong", "reason": "<one sentence>"}.
correct = every priced part matches the truth (a reasonable stated assumption is fine), unpriced parts flagged, nothing invented, right language.
partial = no wrong numbers but a part or total is missing, or an unnecessary caveat.
wrong = any wrong or invented price/total/product, or wrong language.`;

// Every model and Jev call made by this process for one case (agent runs are counted from their events).
type Meter = { usd: number; jevTokens: number };
const als = new AsyncLocalStorage<Meter>();
const PRICE: Record<string, [number, number]> = { deepseek: [0.0648e-6, 0.144e-6], qwen: [0.09e-6, 0.55e-6], mimo: [0.14e-6, 0.28e-6], nemotron: [0.1e-6, 0.4e-6] };
const realFetch = globalThis.fetch;
let M: any;
let tm: TenantManager;

/** Numbers in a text: "1 960", "1960,00", "1.960 zł" -> 1960. */
function numbersOf(t: string): number[] {
  return [...t.replace(/\u00a0/g, " ").matchAll(/\d{1,3}(?:[ .]\d{3})+(?:,\d+)?|\d+(?:[.,]\d+)?/g)].map((m) => {
    let x = m[0];
    if (/^\d{1,3}([ .]\d{3})+/.test(x)) x = x.replace(/[ .](?=\d{3})/g, "");
    return Number(x.replace(",", "."));
  }).filter((n) => Number.isFinite(n));
}
const RANK: Record<string, number> = { correct: 0, partial: 1, wrong: 2, unjudged: 1, error: 3 };

async function judge(c: Case, reply: string, rows: string[]): Promise<{ verdict: string; reason: string }> {
  // Code: every required number present (deterministic). LLM: three judgements, the majority.
  const nums = numbersOf(reply);
  const missing = (c.must || []).filter((alts) => !alts.some((a) => nums.some((n) => Math.abs(n - a) < 0.01)));
  const votes = await Promise.all([0, 1, 2].map(() => judgeOnce(c, reply, rows)));
  const count = (v: string) => votes.filter((x) => x.verdict === v).length;
  let llm = ["correct", "partial", "wrong"].find((v) => count(v) >= 2) || "partial";
  const reason = votes.find((x) => x.verdict === llm)?.reason || votes[0].reason;
  if (missing.length && RANK[llm] < RANK.partial) return { verdict: "partial", reason: `missing required number(s) ${missing.map((a) => a.join("/")).join(", ")}; judge: ${reason}` };
  return { verdict: llm, reason: `${reason}${missing.length ? ` [missing ${missing.map((a) => a.join("/")).join(", ")}]` : ""} (votes ${votes.map((v) => v.verdict[0]).join("")})` };
}

async function judgeOnce(c: Case, reply: string, rows: string[]): Promise<{ verdict: string; reason: string }> {
  for (let k = 0; k < 3; k++) {
    try {
      const r = await realFetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: JUDGE, temperature: 0, max_tokens: 300, response_format: { type: "json_object" }, messages: [{ role: "system", content: JUDGE_SYS }, { role: "user", content: `Customer message:\n${c.msg}\n\nGround truth:\n${c.truth}\n\nPrice list rows:\n${rows.join("\n")}\n\nReply:\n${reply}` }] }) });
      const j: any = await r.json();
      return JSON.parse(j.choices[0].message.content);
    } catch { await new Promise((ok) => setTimeout(ok, 2000)); }
  }
  return { verdict: "unjudged", reason: "judge unavailable" };
}

beforeAll(async () => {
  if (!process.env.PROJECT_AGENT_URL || !process.env.CF_API_TOKEN) return;
  globalThis.fetch = (async (input: any, init?: any) => {
    const res = await realFetch(input, init);
    const m = als.getStore();
    const url = String(input?.url || input);
    if (m && (url.includes("openrouter.ai/api/v1/chat/completions") || url.includes("typesafe.ai"))) {
      res.clone().json().then((j: any) => {
        if (url.includes("typesafe.ai")) { m.jevTokens += Number(j?.usage?.input_tokens) || 0; return; }
        const p = PRICE[Object.keys(PRICE).find((k) => String(j?.model || "").includes(k)) || ""] || [0.1e-6, 0.5e-6];
        m.usd += (j?.usage?.prompt_tokens || 0) * p[0] + (j?.usage?.completion_tokens || 0) * p[1];
      }).catch(() => {});
    }
    return res;
  }) as any;
  const [store, repo, conv, review, cs, reg, tmm, agent, offer] = await Promise.all([import("../src/projects/store.js"), import("../src/projects/repo.js"), import("../src/projects/conversation.js"), import("../src/projects/review.js"), import("../src/storage/conversation-store.js"), import("../src/multi-tenant/d1-registry.js"), import("../src/multi-tenant/tenant-manager.js"), import("../src/projects/agent.js"), import("../src/offer/store.js")]);
  M = { store, repo, conv, review, d1Query: cs.d1Query, numbersIn: agent.numbersIn, offer };
  await reg.hydrateRegistry();
  tm = new tmm.TenantManager();
  process.env.NETWORK_ANSWER_DEADLINE_MS = String(15 * 60_000);
}, 60_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  if (process.env.KEEP_PROJECTS || !M) return;
  const { deleteFromR2 } = await import("../src/storage/r2.js");
  const ids = (await M.d1Query("SELECT id FROM projects WHERE customer_session LIKE ?", [`${run}-%`])).map((r: any) => r.id);
  for (const id of [...ids]) for (const r of await M.d1Query("SELECT id FROM projects WHERE customer_session = ?", [`project:${id}`])) ids.push(r.id);
  for (const id of ids) {
    for (const f of await M.repo.listFiles(id).catch(() => [])) await deleteFromR2(`projects/${id}/${f.path}`).catch(() => {});
    for (const t of ["project_events", "project_participants", "project_consents", "project_files", "project_requirements", "project_reviews", "customer_links"]) await M.d1Query(`DELETE FROM ${t} WHERE project_id = ?`, [id]);
    await M.d1Query("DELETE FROM projects WHERE id = ?", [id]);
  }
  await M.d1Query("DELETE FROM chat_messages WHERE session_id LIKE ?", [`${run}-%`]).catch(() => {});
}, 300_000);

async function oneCase(c: Case) {
  const session = `${run}-${c.id}`;
  const meter: Meter = { usd: 0, jevTokens: 0 };
  return als.run(meter, async () => {
    const t0 = Date.now();
    const chat = await tm.getChatForTenant(TENANT);
    const first = await chat.chat([{ role: "user", content: c.msg } as ChatMessage], session);
    let reply = first.message, route = "chat", status = "answered", pid: string | undefined = first.project?.id;
    if (first.project?.agent?.status === "running" && pid) {
      route = "agent";
      for (const end = Date.now() + 40 * 60_000; ;) {
        const d = await M.conv.agentDelivery(pid, async () => {});
        if (d.status === "done" || d.status === "failed") { reply = d.message || reply; status = d.status; break; }
        // Rentbud's owner approves what its agent prepared (the businesses answer under their own settings).
        const prun = (await M.store.getProject(pid))?.memory.agentRun;
        const rv = prun && d.status === "review" ? await M.review.reviewForRun(pid, prun.runId) : null;
        if (rv?.status === "pending") await M.review.decide(rv.token, "approved", {});
        if (Date.now() > end) { status = "timeout"; break; }
        await new Promise((ok) => setTimeout(ok, 15_000));
      }
    }
    const ms = Date.now() - t0;
    // What the agent runs cost, in the customer's project and in the businesses' projects it asked.
    let agentUsd = 0, runs = 0, sandboxSec = 0;
    const subs: any[] = pid ? ((await M.store.getProject(pid))?.memory.subRequests || []) : [];
    const matched = pid ? (await M.d1Query("SELECT data FROM project_events WHERE project_id = ? AND kind = 'network_matched' ORDER BY at", [pid])).map((e: any) => JSON.parse(e.data)) : [];
    for (const id of [pid, ...subs.map((s) => s.id)].filter(Boolean)) {
      const ev = (await M.d1Query("SELECT kind, at, data FROM project_events WHERE project_id = ? AND kind IN ('agent_started','agent_finished') ORDER BY at", [id])).map((e: any) => ({ kind: e.kind, at: e.at, ...JSON.parse(e.data) }));
      const fin = ev.filter((e: any) => e.kind === "agent_finished"), sta = ev.filter((e: any) => e.kind === "agent_started");
      runs += fin.length;
      agentUsd += fin.reduce((s: number, e: any) => s + (e.usage?.costUsd || 0), 0);
      sandboxSec += fin.reduce((s: number, e: any, k: number) => s + (Date.parse(e.at) - Date.parse(sta[k]?.at || e.at)) / 1000, 0);
    }
    let pii = false;
    for (const s of subs) { const q = (await M.repo.readFile(s.id, "request.txt").catch(() => "")) || ""; if (PII.some((p) => q.includes(p))) pii = true; }
    const rows: string[] = [];
    for (const [t, keys] of c.rows) for (const i of ((await M.offer.loadOffer(t).catch(() => ({ items: [] }))).items as any[]).filter((x) => keys.some((k) => x.name.toLowerCase().includes(k))).slice(0, 25)) rows.push(`${t}: ${M.offer.renderItem(i).slice(0, 400)}`);
    const verdict = await judge(c, reply, rows);
    return { id: c.id, route, status, ms, reply, verdict, pii, subs: subs.map((s) => ({ to: s.tenantId, status: s.status, q: s.question })), matched, runs, agentUsd, sandboxSec, serverUsd: meter.usd, jevUsd: meter.jevTokens * 0.042e-6 };
  });
}

live("the whole chain on realistic customer messages", () => {
  it("routes, advertises, answers across businesses and replies correctly", async () => {
    const only = (process.env.CHAIN_CASES || "").split(",").filter(Boolean);
    const todo = CASES.filter((c) => !only.length || only.includes(c.id));
    const results: any[] = [];
    let next = 0;
    await Promise.all(Array.from({ length: AT_ONCE }, async () => {
      while (next < todo.length) {
        const c = todo[next++];
        const r = await oneCase(c).catch((e) => ({ id: c.id, status: "error", error: String(e?.stack || e).slice(0, 400), verdict: { verdict: "error", reason: "" } }));
        console.log(`[case] ${JSON.stringify(r)}`);
        results.push(r);
      }
    }));
    const count = (v: string) => results.filter((r) => r.verdict?.verdict === v).length;
    const ok = results.filter((r) => r.status !== "error");
    console.log(`[summary] ${JSON.stringify({ cases: results.length, correct: count("correct"), partial: count("partial"), wrong: count("wrong"), errors: count("error"),
      usdPerCase: ok.reduce((s, r) => s + r.agentUsd + r.serverUsd + r.jevUsd, 0) / (ok.length || 1), sandboxSecPerCase: ok.reduce((s, r) => s + r.sandboxSec, 0) / (ok.length || 1),
      medianSec: [...ok].map((r) => r.ms / 1000).sort((a, b) => a - b)[Math.floor(ok.length / 2)] })}`);
    expect(results.filter((r) => r.pii).length).toBe(0);
    expect(count("error")).toBe(0);
    expect(count("wrong")).toBeLessThanOrEqual(Math.ceil(results.length * 0.2));
  }, 180 * 60_000);
});
