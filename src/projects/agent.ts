/**
 * The project agent: a coding agent (opencode + a cheap model via OpenRouter) that works in a project's
 * repository with full tools - shell, python, files - in a Cloudflare sandbox (workers/project-agent).
 *
 *   1. start: the repository's files (customer data -> masked by the runner before the sandbox sees them)
 *      plus the participating businesses' offers as price lists (public data, not masked) and the rules
 *      (AGENTS.md) go to the runner. One run per project at a time.
 *   2. the runner masks personal data, runs the agent, unmasks its outputs (placeholder mapping never
 *      enters the sandbox) - workers/project-agent/src/agent.ts.
 *   3. collect (polling here, or lazily on a status request after a restart): outputs go into the
 *      repository (author "agent:<model>"), usage into the project, then code + Jev verify them as
 *      requirements (sys-agent-*). A failed run is retried once on the fallback model.
 *
 * Numbers in anything the customer reads must come from files (prices, computed totals); the checks
 * enforce it. Env: PROJECT_AGENT_URL, PROJECT_AGENT_SECRET, PROJECT_AGENT_MODEL, PROJECT_AGENT_FALLBACK_MODEL.
 */
import { getProject, setMemory, addEvent, addUsage, listParticipants, claimAgentCollect, type Project } from "./store.js";
import { listFiles, readFile, writeFile, writeBinaryFile, addRequirement, listRequirements, recordVerification, toCsv, type FileKind, type ReqStatus } from "./repo.js";
import { loadOffer, priceText, type OfferItem } from "../offer/store.js";
import type { Advert } from "./network.js";
import type { NetworkOffer } from "./broadcast.js";
import { FIELDS } from "../offer/schema.js";
import { jevAsk } from "../llm/jev.js";
import { getTenant } from "../multi-tenant/d1-registry.js";

export interface ModelSpec { id: string; name: string; cost: { input: number; output: number; cache_read?: number } }

// USD per million tokens (OpenRouter, 2026-10-12). Benchmarked on 25 real project tasks x 4 runs:
// DeepSeek V4.1 Flash 97/100 (p50 27 s, ~$0.01/task), MiMo-V2.6-Flash slower and cheaper.
export const MODELS: Record<string, ModelSpec> = {
  "deepseek/deepseek-v4.1-flash": { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash", cost: { input: 0.15, output: 0.6, cache_read: 0.003 } },
  "xiaomi/mimo-v2.6-flash": { id: "xiaomi/mimo-v2.6-flash", name: "MiMo-V2.6-Flash", cost: { input: 0.14, output: 0.28, cache_read: 0.0028 } },
};
const primaryModel = () => MODELS[process.env.PROJECT_AGENT_MODEL || ""] || MODELS["deepseek/deepseek-v4.1-flash"];
const fallbackModel = () => MODELS[process.env.PROJECT_AGENT_FALLBACK_MODEL || ""] || MODELS["xiaomi/mimo-v2.6-flash"];

const POLL_MS = 10_000;
const PRICE_DIR = "cenniki";
const MAX_RUN_MS = 20 * 60 * 1000;
const MAX_INPUT_FILE = 512 * 1024;
const LANGS: Record<string, string> = { pl: "Polish", en: "English", uk: "Ukrainian", fr: "French", de: "German", other: "another language" };

export interface AgentRunState {
  runId: string;
  model: string;
  instruction: string;
  status: "running" | "collecting" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  attempt: number;
  stopReason?: string;
  error?: string;
  files?: string[];
  verification?: { met: number; failed: number };
  costUsd?: number;
  needsOwner?: boolean; // the reply may contain content for the business: the owner reviews it first
}

export function agentEnabled(): boolean {
  return !!(process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET);
}

async function runner(path: string, init: RequestInit = {}, timeoutMs = 180_000): Promise<Response> {
  let base = process.env.PROJECT_AGENT_URL || "";
  while (base.endsWith("/")) base = base.slice(0, -1);
  return fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Authorization: `Bearer ${process.env.PROJECT_AGENT_SECRET}`, "Content-Type": "application/json", ...(init.headers || {}) },
  });
}

// General working rules for any project (a quote, a comparison, an order list, a schedule, an analysis,
// a document...). What to deliver comes from the task; these say how to work. Anything specific to one
// kind of project belongs in its task text, not here.
export const BUSINESS_QUESTIONS = "pytania_do_firmy.md";

const RULES = `# Agent projektu Whisp

Pracujesz w repozytorium projektu (bieżący katalog): to są wszystkie dane projektu - wiadomości klienta,
wcześniejsze wyniki, notatki. Oferty firm biorących udział w projekcie są w cenniki/ (opis formatu: cenniki/README.md).
Klient ani firma nie odpowiedzą w trakcie pracy - nie zadawaj pytań. Gdy czegoś brakuje albo coś jest niejasne,
przyjmij najrozsądniejsze założenie, zapisz je w zalozenia.md i oznacz w wynikach jako założenie.

Zasady:
1. Fakty tylko z danych. Ceny, terminy, dostępność, warunki, nazwy - wyłącznie z plików repozytorium.
   Niczego nie wymyślaj. Czego nie ma w danych, oznacz wprost jako nieznane / do ustalenia (np. status "do_wyceny").
   Cena firmy to tylko cena z jej oferty lub cennika. Ceny z artykułów i poradników na stronie (orientacyjne ceny
   rynkowe, często cytowane z innych serwisów) nie są cenami firmy - nie przypisuj ich firmie i nie licz z nich wyceny.
2. Każde obliczenie (sumy, ilości, przeliczenia jednostek, daty, porównania) wykonuj kodem (python3) i zostaw
   skrypt w repozytorium. Nigdy nie licz w pamięci. Wyniki obliczeń zapisuj do pliku (np. obliczenia.csv) -
   każda liczba podana w tekście musi występować w danych albo w zapisanym pliku z obliczeniami.
3. Nazwy z danych (pozycje, firmy) przepisuj dokładnie, bez tłumaczenia - także w tekstach w innym języku.
4. Pliki, o które prosi zadanie, zapisz dokładnie pod podanymi nazwami i w podanym formacie.
   Domyślnie: tabele jako CSV (separator ";", kropka dziesiętna, nagłówek w pierwszym wierszu), teksty jako .md lub .txt,
   dane dla programów jako .json. Nie twórz plików binarnych (xlsx, pdf) - arkusze i dokumenty tworzy system.
5. Tekst dla klienta (gdy zadanie o niego prosi; domyślnie odpowiedz.txt) pisz w JĘZYKU KLIENTA - języku jego wiadomości.
   Krótko i konkretnie; tylko to, co wynika z danych i obliczeń; wyraźnie wskaż, co jest nieznane lub do ustalenia;
   bez obietnic, których nie ma w danych.
6. Gdy kilka firm oferuje to samo, porównuj na tych samych warunkach (ilość, okres, jednostka) i wyjaśnij wybór.
   Gdy w danych jest kilka pozycji tego samego (np. ta sama rzecz z różnymi stawkami), sprawdź wszystkie i wybierz
   najkorzystniejszą dla klienta.
   Tylko to, o co prosi klient: nie doliczaj rzeczy, o które nie prosił (np. sprzętu do usługi, której cena jest do wyceny).
   Gdy klient prosi o coś, czego w danych nie ma, napisz to wprost; zamiennik możesz zaproponować, ale nazwij go tym,
   czym jest (nie nazwą rzeczy, o którą prosił klient).
7. Sprawdź swoje wyniki przed zakończeniem (np. czy sumy się zgadzają, czy każda pozycja z zadania jest ujęta).
   Na końcu napisz krótko, co zrobiłeś i jakie pliki powstały.
8. Tekst i pliki dla klienta są gotowe do wysłania: bez pytań do firmy, bez notatek wewnętrznych, bez próśb
   o potwierdzenie czegokolwiek przez firmę. Pytanie do firmy zapisz w ${BUSINESS_QUESTIONS} (jedno w linii) tylko
   wtedy, gdy bez odpowiedzi firmy wynik dla klienta może być błędny - czyli dotyczy tego, o co klient prosi, a danych
   o tym nie ma (np. klient chce koszt z dowozem, a cennik nie podaje ceny dowozu). Nie pytaj o sprawy, których klient
   nie poruszył (dostępność terminów, dowóz, kaucja itp.) ani o rzeczy, które wynikają z danych. Wynik przygotuj
   na najrozsądniejszym założeniu (zapisanym w zalozenia.md); firma odpowie, zanim klient go dostanie.
9. Inne firmy z sieci (cenniki/firmy.md, jeśli jest): tylko dla części, o które prosi zlecający (nie dodawaj
   rzeczy, o które nie prosił): gdy taka część należy do innej firmy z tej listy, a jej
   cennik nie podaje potrzebnej ceny lub informacji (albo firma nie ma cennika), zapytaj ją: zapisz
   zapytania_do_firm.json - lista [{"firma": "<identyfikator z firmy.md>", "pytanie": "konkretne pytanie z ilościami
   i warunkami"}]. Pytaj firmę, której dopasowane pozycje są dokładnie tą częścią - nie firmy z samymi ogólnymi
   usługami (np. "usługi budowlane"), gdy jest firma z konkretną pozycją. W pytaniach nie podawaj danych osobowych klienta. Wynik przygotuj tak, jakby ta część była do
   wyceny; gdy firmy odpowiedzą, dostaniesz zadanie dokończenia. Nie pytaj firmy prowadzącej projekt; gdy
   w jej danych brakuje ceny produktu lub usługi, który inna firma z listy też oferuje (ten sam produkt lub usługa) -
   zapytaj tamtą. Usługa dodatkowa do rzeczy firmy prowadzącej (np. dowóz jej sprzętu) to sprawa tej firmy, nie innych.
   W tekście dla klienta nie pisz o zapytaniach do innych firm ani o tym, co zrobisz później - o tym informuje
   klienta system; opisz tylko to, co jest teraz (części bez ceny: "do wyceny").
`;

// cenniki/README.md: how the offer files are laid out (general, for any business type).
const PRICE_README = `# Oferty firm

Zapytanie trafiło do firm z sieci; każda sprawdziła je na swojej ofercie. W firmy.md są tylko firmy, które mają coś
do tego zapytania. Dla każdej z nich:
- cennik_<firma>.csv - pozycje oferty, które firma dopasowała do zapytania: id, nazwa, kategoria, cena (opis ceny),
  cena_od, cena_do, waluta, jednostka, dostepnosc, czas_realizacji, opis. Pusta cena = brak ceny w ofercie (do ustalenia z firmą).
- oferta_<firma>.csv (tylko firma prowadząca projekt) - cała jej oferta, w tym samym formacie, gdy dopasowanych pozycji
  nie wystarcza (np. zamiennik, wariant, akcesoria).
- skladniki_<firma>.csv (jeśli są) - pozycje, których cena składa się z kilku części: id_pozycji, pozycja, skladnik,
  cena, cena_do, jednostka, polaczenie, ilosc_od_klienta.
  polaczenie = "suma": części się sumują (np. robocizna + materiał);
  polaczenie = "do_wyboru": klient płaci jedną z nich (np. stawka godzinowa albo dobowa, albo wariant produktu) -
  wybierz tę, o którą prosi klient; gdy to tylko sposób rozliczenia, tę najkorzystniejszą dla klienta przy danej
  ilości (doba = 24 h).
  ilosc_od_klienta: czego ilość podaje klient (np. metraż) - jeśli jej nie podał, to jest założenie albo "do ustalenia".
Firma bez pliku cennika zgłosiła, że to oferuje (na podstawie opisu) - o ceny trzeba ją zapytać.
oferty_sieci.md (jeśli jest) - oferty firm z sieci dla każdej części prośby, najlepsze najpierw: punkt wyjścia do wyboru
firm; ceny sprawdź w cennikach i przelicz sam.
`;

const unitLabel = (u?: string) => (u && u !== "unknown" ? FIELDS.unit.values[u]?.label || u : "");
const fieldLabel = (f: keyof typeof FIELDS, v?: string) => (v && v !== "unknown" ? (FIELDS[f].values as any)[v]?.label || v : "");

function itemsCsv(items: OfferItem[]): string {
  return toCsv(
    ["id", "nazwa", "kategoria", "cena", "cena_od", "cena_do", "waluta", "jednostka", "dostepnosc", "czas_realizacji", "opis"],
    items.map((i) => [i.id.slice(0, 8), i.name, i.category, priceText(i) || (i.components.some((c) => c.price_value !== null) ? "patrz skladniki" : ""), i.price_value, i.price_max, i.currency,
      unitLabel(i.fields.unit), fieldLabel("availability", i.fields.availability), fieldLabel("lead_time", i.fields.lead_time), i.description.slice(0, 300)]),
  ).slice(1); // no BOM: the agent reads these with python
}

function componentsCsv(items: OfferItem[]): string | null {
  const rows = items.flatMap((i) => i.components.map((c) => [i.id.slice(0, 8), i.name, c.label, c.price_value, c.price_max, unitLabel(c.unit), c.combine === "sum" ? "suma" : "do_wyboru", c.quantity_from === "customer" ? c.quantity_label || "tak" : ""]));
  return rows.length ? toCsv(["id_pozycji", "pozycja", "skladnik", "cena", "cena_do", "jednostka", "polaczenie", "ilosc_od_klienta"], rows).slice(1) : null;
}

/**
 * The offers of the businesses that answered the need (public data): the items each matched, and for the
 * business running the project its whole offer too. Businesses that have nothing for it stay out.
 */
async function priceLists(project: Project, adverts: Advert[], mustAsk: string[] | null): Promise<{ files: Record<string, string>; allow: string[]; catalog: string[]; slugs: Record<string, string> }> {
  const files: Record<string, string> = {};
  const slugs: Record<string, string> = {};
  const { networkMembers } = await import("./network.js");
  const about = new Map((await networkMembers(project.initiatorTenantId).catch(() => [])).map((m) => [m.tenantId, m.about]));
  const directory: string[] = [];
  const allow: string[] = [];
  const catalog = new Set<string>();
  const used = new Set<string>();
  const own = project.initiatorTenantId;
  const byTenant = new Map(adverts.map((a) => [a.tenantId, a]));
  const ownOffer = (await loadOffer(own).catch(() => null))?.items || [];
  for (const tenantId of [own, ...adverts.map((a) => a.tenantId).filter((id) => id !== own)]) {
    const ad = byTenant.get(tenantId);
    const t = getTenant(tenantId);
    const label = t?.settings?.siteCard?.brand || t?.brandName || t?.domain || tenantId;
    allow.push(label, t?.domain || "", t?.siteUrl || "");
    let slug = fileSlug(label) || fileSlug(tenantId);
    while (used.has(slug)) slug += "_";
    used.add(slug);
    slugs[slug] = tenantId;
    const matched = ad?.items || [];
    const whole = tenantId === own ? ownOffer : [];
    const lines = [`## ${slug}: ${label}${tenantId === own ? " (firma prowadząca ten projekt)" : ""}`, about.get(tenantId) || "(brak opisu)"];
    if (matched.length) lines.push(`Pozycje dopasowane do zapytania: cennik_${slug}.csv (${matched.length})`);
    // Which businesses must be asked (rule 9) was decided before the run (mustAskBusinesses); without
    // that decision (Jev down), matched items without a price decide.
    if (tenantId !== own && mustAsk) {
      if (mustAsk.includes(tenantId)) lines.push("Ma to, o co prosi klient, a ceny w danych nie ma - trzeba zapytać firmę (zapytania_do_firm.json).");
    } else if (tenantId !== own) {
      const unpriced = matched.filter((i) => (!priceText(i) || priceText(i) === "cena na zapytanie") && !i.components.some((c) => c.price_value !== null));
      if (unpriced.length) lines.push(unpriced.length === matched.length ? "W dopasowanych pozycjach nie ma cen - o ceny trzeba zapytać firmę." : `Bez ceny: ${unpriced.slice(0, 8).map((i) => i.name).join("; ")} - o ich ceny trzeba zapytać firmę.`);
    }
    if (whole.length) lines.push(`Cała oferta: oferta_${slug}.csv (${whole.length})`);
    if (!matched.length && !whole.length) lines.push("Brak cennika w danych - o ceny trzeba zapytać firmę.");
    directory.push(lines.join("\n"));
    if (matched.length) files[`cennik_${slug}.csv`] = itemsCsv(matched);
    if (whole.length) files[`oferta_${slug}.csv`] = itemsCsv(whole);
    const comps = componentsCsv([...new Map([...matched, ...whole].map((i) => [i.id, i])).values()]);
    if (comps) files[`skladniki_${slug}.csv`] = comps;
    for (const i of [...matched, ...whole]) for (const w of i.name.split(" ")) if (w.length > 2) catalog.add(w);
  }
  if (directory.length > 1) files["firmy.md"] = `# Firmy z sieci, które mają coś do tego zapytania\n\n${directory.join("\n\n")}\n`;
  return { files, allow: allow.filter(Boolean), catalog: [...catalog].slice(0, 3000), slugs };
}

const withoutBom = (t: string) => (t.startsWith("\uFEFF") ? t.slice(1) : t);

function fileSlug(s: string): string {
  const map: Record<string, string> = { ą: "a", ć: "c", ę: "e", ł: "l", ń: "n", ó: "o", ś: "s", ź: "z", ż: "z" };
  let out = "";
  for (const ch of s.toLowerCase()) {
    const c = map[ch] ?? ch;
    if ((c >= "a" && c <= "z") || (c >= "0" && c <= "9")) out += c;
    else if (out && !out.endsWith("_")) out += "_";
  }
  while (out.endsWith("_")) out = out.slice(0, -1);
  return out.slice(0, 40);
}

/** cenniki/oferty_sieci.md: the offers the network gave per part, best first (picked by Jev). */
function networkOffersText(parts: string[], offers: NetworkOffer[], own: string, businessLabel: (id: string) => string, isListed: (id: string) => boolean): string {
  const out = ["# Oferty firm z sieci (wybrane najlepsze dla każdej części; ceny przelicz sam - nie przepisuj wyników)", ""];
  parts.forEach((p, k) => {
    out.push(`## Część ${k + 1}: ${p}`);
    const mine = offers.filter((o) => o.part === k);
    if (!mine.length) out.push("Żadna firma z sieci nie złożyła oferty.");
    mine.forEach((o, n) => out.push(`${n + 1}. ${businessLabel(o.tenantId)}${o.tenantId === own ? " (firma prowadząca)" : ""}${isListed(o.tenantId) ? " (z publicznych danych firmy, niepotwierdzone)" : ""} - ${o.precise ? "cena z cennika" : "cena do ustalenia"}: ${o.text}${o.items.length ? ` [pozycje: ${o.items.map((i) => i.name).join("; ")}]` : ""}`));
    out.push("");
  });
  return out.join("\n");
}

/** What the project asks for now: the latest request and the recent conversation around it. */
async function needOf(projectId: string): Promise<string> {
  const [request, talk] = await Promise.all([readFile(projectId, "request.txt").catch(() => null), readFile(projectId, "rozmowa.md").catch(() => null)]);
  return [(request || "").trim(), (talk || "").slice(-1500)].filter(Boolean).join("\n\n");
}

/**
 * Puts the businesses' data in the repository (public, sent unmasked). The need goes out to the network
 * (advertise): businesses that have something for it come in with the items they matched; the business
 * running the project also with its whole offer. A business answering a request is alone with its own
 * offer. Reused while the need is the same (planner and run share it, up to 10 minutes).
 */
export async function prepareInputs(projectId: string): Promise<{ allow: string[]; catalog: string[] }> {
  const project = await getProject(projectId);
  if (!project) return { allow: [], catalog: [] };
  const { createHash } = await import("crypto");
  const hash = (t: string) => createHash("sha1").update(t).digest("hex");
  const need = await needOf(projectId);
  const needHash = hash(need);
  const cached = project.memory.inputs as { at: number; need?: string; allow: string[]; catalog: string[] } | undefined;
  if (cached && cached.need === needHash && Date.now() - cached.at < 10 * 60_000) return cached;
  const { networkMembers, advertise, BUSINESS_REQUEST } = await import("./network.js");
  const tenantIds = project.type === BUSINESS_REQUEST ? [project.initiatorTenantId]
    : [...new Set([project.initiatorTenantId, ...(await listParticipants(projectId)).map((p) => p.tenantId), ...(await networkMembers(project.initiatorTenantId).catch(() => [])).map((m) => m.tenantId)])];
  const t0 = Date.now();
  // A business answering a request: alone with its own offer. The customer's project: the request is
  // broadcast to the network, every business answers or declines, Jev picks the best offers per part
  // (src/projects/broadcast.ts) - once per request; the later rounds of the same request reuse them.
  let adverts: Advert[] = [];
  let mustAsk: string[] | null = [];
  let networkOffers: NetworkOffer[] = [];
  let parts: string[] = [];
  if (project.type === BUSINESS_REQUEST) adverts = need ? await advertise(need, tenantIds) : [];
  // Quantities only (how much material for these sizes): nothing to price, so nobody to ask - the
  // network is not involved (it once had the agent ask a contractor to quote a wall for a board count).
  else if (need && !project.memory.pureCalc) {
    const prevB = project.memory.broadcast as { need: string; parts: string[]; picked: { tenantId: string; part: number; precise: boolean; text: string; items: string[] }[] } | undefined;
    const { loadOffer } = await import("../offer/store.js");
    if (prevB?.need === needHash) {
      const offersOf = new Map(await Promise.all([...new Set(prevB.picked.map((o) => o.tenantId))].map(async (id) => [id, (await loadOffer(id).catch(() => null))?.items || []] as const)));
      networkOffers = prevB.picked.map((o) => ({ ...o, items: (offersOf.get(o.tenantId) || []).filter((i) => o.items.includes(i.id)) }));
      parts = prevB.parts;
    } else {
      const { broadcastNeed } = await import("./broadcast.js");
      const b = await broadcastNeed(need, tenantIds);
      networkOffers = b.picked; parts = b.parts;
      await setMemory(projectId, { broadcast: { need: needHash, parts: b.parts, picked: b.picked.map((o) => ({ ...o, items: o.items.map((i) => i.id) })) } });
      await addEvent(projectId, { kind: "network_offers", actor: "system", data: { ms: b.ms, parts: b.parts, answered: b.answered, declined: b.declined, picked: b.picked.map((o) => ({ tenantId: o.tenantId, part: o.part, precise: o.precise, text: o.text.slice(0, 300) })) } }).catch(() => {});
    }
    // The businesses whose offers were picked come in with the items behind them; the business running
    // the project with its whole offer. A picked offer without a price: that business must be asked.
    const byTenant = new Map<string, OfferItem[]>();
    for (const o of networkOffers) byTenant.set(o.tenantId, [...new Map([...(byTenant.get(o.tenantId) || []), ...o.items].map((i) => [i.id, i])).values()]);
    adverts = [...byTenant].map(([tenantId, items]) => ({ tenantId, items, byDescription: !items.length }));
    // Per part, the best offer without a price is asked for one - when the part has no priced offer, or
    // when that offer was picked first (Jev found it better than the priced ones).
    const ask: string[] = [];
    for (let k = 0; k < parts.length; k++) {
      const mine = networkOffers.filter((o) => o.part === k);
      const vague = mine.find((o) => !o.precise && o.tenantId !== project.initiatorTenantId);
      if (vague && (!mine.some((o) => o.precise) || mine[0] === vague)) ask.push(vague.tenantId);
    }
    mustAsk = project.memory.networkAsked ? [] : [...new Set(ask)].slice(0, 4);
  }
  const offers = await priceLists(project, adverts, mustAsk);
  if (networkOffers.length) {
    const net = await import("./network.js");
    offers.files["oferty_sieci.md"] = networkOffersText(parts, networkOffers, project.initiatorTenantId, net.businessLabel, net.isListed);
  }
  const out: Record<string, string> = {};
  for (const [name, body] of Object.entries(offers.files)) out[`${PRICE_DIR}/${name}`] = body;
  if (Object.keys(offers.files).length) out[`${PRICE_DIR}/README.md`] = PRICE_README;
  if (!offers.files["firmy.md"]) out[`${PRICE_DIR}/firmy.md`] = "";
  // Only what changed is written, all at once; offer files of businesses no longer in it are removed.
  const prev = (project.memory.inputHashes as Record<string, string>) || {};
  const hashes: Record<string, string> = {};
  const { deleteFile } = await import("./repo.js");
  await Promise.all([
    ...Object.entries(out).map(async ([path, body]) => {
      hashes[path] = hash(body);
      if (prev[path] !== hashes[path]) await writeFile(projectId, path, body, path.endsWith(".csv") ? "csv" : "md", "system");
    }),
    ...(await listFiles(projectId)).filter((f) => f.path.startsWith(`${PRICE_DIR}/`) && !(f.path in out)).map((f) => deleteFile(projectId, f.path)),
  ]);
  const inputs = { at: Date.now(), need: needHash, allow: offers.allow, catalog: offers.catalog.slice(0, 1500) };
  await setMemory(projectId, { businessSlugs: offers.slugs, inputs, inputHashes: hashes, mustAsk: mustAsk || [] });
  await addEvent(projectId, { kind: "network_matched", actor: "system", data: { ms: Date.now() - t0, mustAsk: mustAsk ?? [], businesses: adverts.map((a) => ({ tenantId: a.tenantId, items: a.items.length, ...(a.byDescription ? { byDescription: true } : {}), ...(a.unjudged ? { unjudged: true } : {}) })) } }).catch(() => {});
  return inputs;
}

/** Wakes the project's sandbox and the masker while the request is still being prepared and planned. */
export function warmRunner(projectId: string): void {
  if (!agentEnabled()) return;
  void runner(`/projects/${encodeURIComponent(projectId)}/warm`, { method: "POST" }, 120_000)
    .catch((e) => console.warn(`[project-agent] ${projectId}: warm-up failed: ${e?.message || e}`));
}

export async function startAgentRun(projectId: string, instruction: string, actor: string, attempt = 1, model = primaryModel(), retryOf?: string, timing: Record<string, number> = {}): Promise<AgentRunState | { error: string }> {
  const t0 = Date.now();
  if (!agentEnabled()) return { error: "The project agent is not configured." };
  const project = await getProject(projectId);
  if (!project) return { error: "Project not found." };
  const prev = project.memory.agentRun as AgentRunState | undefined;
  // A retry of the run being collected (retryOf = its runId) may replace it; anything else waits.
  if (prev && prev.runId !== retryOf && (prev.status === "running" || prev.status === "collecting") && Date.now() - Date.parse(prev.startedAt) < MAX_RUN_MS) return { error: "The agent is already working on this project." };

  // The businesses' current offers become part of the repository (what the agent priced from), sent
  // unmasked: they are public data. Everything else may hold customer data and is masked by the runner.
  const offers = await prepareInputs(projectId);
  const files: Record<string, string> = {};
  const publicFiles: Record<string, string> = {};
  // Not sent: the runner's reports, old spec versions and replaced replies (the spec is in AGENTS.md).
  const listed = (await listFiles(projectId)).filter((f) => f.size <= MAX_INPUT_FILE && f.kind !== "bin" && !f.path.startsWith("agent/") && !f.path.startsWith("plan/") && !f.path.startsWith("historia/") && f.path !== "plan.json");
  const bodies = await Promise.all(listed.map((f) => readFile(projectId, f.path).catch(() => null)));
  listed.forEach((f, k) => {
    const body = bodies[k];
    if (body === null) return;
    // Business data (offers, the business's own site content) is public: not masked.
    if (f.path.startsWith(`${PRICE_DIR}/`) || f.path.startsWith("wiedza/")) publicFiles[f.path] = withoutBom(body);
    else files[f.path] = withoutBom(body);
  });
  // A planned project: the frozen spec is part of the harness's system prompt; the prompt only points to it.
  const spec = project.memory.plan as import("./plan.js").Spec | undefined;
  const { renderSpec } = await import("./plan.js");
  // Quantities only: a calculation from the customer's own figures - no prices, no other businesses.
  const pureCalc = project.memory.pureCalc ? "\n\nTo czyste wyliczenie ilości z danych klienta: policz i odpowiedz. Bez cen i bez pytania innych firm (nie twórz zapytania_do_firm.json)." : "";
  const rules = (spec ? RULES + renderSpec(spec) : RULES) + pureCalc;
  const prompt = spec ? `Wykonaj specyfikację z AGENTS.md (v${spec.version}).${instruction ? `\n\n${instruction}` : ""}` : `Zadanie projektu "${project.title || project.type}":\n${instruction}\n\nZasady pracy są w AGENTS.md.`;

  timing.readFilesMs = Date.now() - t0;
  const tRunner = Date.now();
  const r = await runner(`/projects/${encodeURIComponent(projectId)}/run`, {
    method: "POST",
    body: JSON.stringify({ prompt, rules, files, publicFiles, keepMasked: [(await import("./network.js")).REQUESTS_FILE], model, maxSteps: 60, timeoutSec: 900, maxCostUsd: 0.5, allow: offers.allow, catalog: offers.catalog }),
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e?.message || e) }) as unknown as Response);
  if (r.status === 409) return { error: "The agent is already working on this project." };
  if (!r.ok) return { error: `The agent could not start (${r.status}): ${(await r.text()).slice(0, 200)}` };
  const { runId, timing: runnerTiming } = (await r.json()) as { runId: string; timing?: Record<string, number> };
  timing.runnerMs = Date.now() - tRunner;
  Object.assign(timing, runnerTiming || {});
  const state: AgentRunState = { runId, model: model.id, instruction: instruction.slice(0, 2000), status: "running", startedAt: new Date().toISOString(), attempt };
  await setMemory(projectId, { agentRun: state });
  await addEvent(projectId, { kind: "agent_started", actor, data: { runId, model: model.id, attempt, timing, files: Object.keys(files), priceLists: Object.keys(publicFiles) } });
  void poll(projectId, runId);
  return state;
}

const polling = new Set<string>();
async function poll(projectId: string, runId: string): Promise<void> {
  if (polling.has(runId)) return;
  polling.add(runId);
  try {
    const deadline = Date.now() + MAX_RUN_MS;
    while (Date.now() < deadline) {
      await new Promise((ok) => setTimeout(ok, POLL_MS));
      const s = await agentStatus(projectId).catch(() => null);
      if (!s || s.runId !== runId || s.status === "done" || s.status === "failed") return;
    }
  } finally {
    polling.delete(runId);
  }
}

/**
 * The run's state; when the runner has finished, collects the result (once) - so a run survives a
 * restart of this server: the next status request finishes it.
 */
export async function agentStatus(projectId: string): Promise<AgentRunState | null> {
  const project = await getProject(projectId);
  const state = project?.memory.agentRun as AgentRunState | undefined;
  if (!project || !state || state.status === "done" || state.status === "failed") return state || null;
  if (state.status === "collecting" && Date.now() - Date.parse(state.finishedAt || state.startedAt) < 120_000) return state;
  const r = await runner(`/projects/${encodeURIComponent(projectId)}/run`, { method: "GET" }, 60_000);
  if (!r.ok) return state;
  const s = (await r.json()) as any;
  if (s.state === "running") return state;
  if (s.state === "none" || s.result?.runId !== state.runId) {
    const failed: AgentRunState = { ...state, status: "failed", error: "The run was lost.", finishedAt: new Date().toISOString() };
    await setMemory(projectId, { agentRun: failed });
    return failed;
  }
  // One collector only (the poller and a status request can both get here).
  if (!(await claimAgentCollect(projectId, state.runId))) return ((await getProject(projectId))?.memory.agentRun as AgentRunState) || state;
  const collecting: AgentRunState = { ...state, status: "collecting", finishedAt: new Date().toISOString() };
  return collect(project, collecting, s.result);
}

interface RunResult {
  runId: string; state: "succeeded" | "failed" | "lost"; stopReason: string; error?: string; finalText: string;
  files: { path: string; encoding: "utf-8" | "base64"; content: string; size: number }[];
  skippedFiles: string[]; unknownPlaceholders: string[]; alteredPlaceholders: string[]; piiMasked: number;
  usage: { steps: number; costUsd: number; toolCalls: number; toolErrors: number };
}

async function collect(project: Project, state: AgentRunState, result: RunResult): Promise<AgentRunState> {
  const id = project.id;
  const author = `agent:${state.model}`;
  const written: string[] = [];
  for (const f of result.files) {
    try {
      if (f.encoding === "base64") await writeBinaryFile(id, f.path, Buffer.from(f.content, "base64"), author);
      else await writeFile(id, f.path, f.content, kindOf(f.path), author);
      written.push(f.path);
    } catch (e: any) {
      console.warn(`[project-agent] ${id} could not store ${f.path}: ${e?.message || e}`);
    }
  }
  await writeFile(id, "agent/raport.md", report(state, result), "md", "system").catch(() => {});
  await addUsage(id, { llmCalls: result.usage.steps, costUsd: result.usage.costUsd }).catch(() => {});
  await addEvent(id, { kind: "agent_finished", actor: author, data: { runId: result.runId, state: result.state, stopReason: result.stopReason, files: written, usage: result.usage, piiMasked: result.piiMasked, timing: (result as any).timing } });
  // Release the runner's copy (result and mapping are gone afterwards).
  await runner(`/projects/${encodeURIComponent(id)}/run`, { method: "DELETE" }, 30_000).catch(() => {});

  const verification = await verifyOutputs(id, result, state.instruction).catch((e) => {
    console.warn(`[project-agent] ${id} verification error: ${e?.message || e}`);
    return null;
  });
  // A reply that may speak to the business is not a failed run: the owner sees it first (needsOwner).
  const hard = (verification?.failed || 0) - (verification?.customerOnlyFailed ? 1 : 0) - (verification?.specFailed || 0);
  const clean = result.state === "succeeded" && result.unknownPlaceholders.length === 0 && result.alteredPlaceholders.length === 0 && hard === 0;
  // First attempt: any failed criterion earns a repair pass. After it, only hard checks decide.
  const ok = clean && (state.attempt > 1 || !(verification?.specFailed));
  const done: AgentRunState = {
    ...state, status: ok ? "done" : "failed", stopReason: result.stopReason, error: result.error?.slice(0, 500),
    files: written, verification: verification ? { met: verification.met, failed: verification.failed } : undefined,
    needsOwner: !!verification?.customerOnlyFailed,
    costUsd: result.usage.costUsd, finishedAt: new Date().toISOString(),
  };
  const finished = async () => {
    await setMemory(id, { agentRun: done });
    await import("./conversation.js").then((m) => m.onRunFinished(id)).catch((e) => console.warn(`[project-agent] ${id} after-run: ${e?.message || e}`));
    return done;
  };
  // Requests to other businesses went out: gaps are expected until they answer, and the run that follows
  // their answers is verified again - no repair pass now.
  const { REQUESTS_FILE } = await import("./network.js");
  const asking = result.state === "succeeded" && result.files.some((f) => f.path === REQUESTS_FILE) && !(await getProject(id))?.memory.networkAsked;
  if (ok || asking || state.attempt > 1) return finished();
  // One more attempt, started before this run is marked finished (so nobody delivers the failure in
  // between): a run that failed goes to the fallback model; a run whose outputs did not verify gets a
  // repair pass on the same model, told exactly what to fix (its files are in the repository now).
  const again = result.state !== "succeeded"
    ? await startAgentRun(id, state.instruction, "system", 2, fallbackModel().id !== state.model ? fallbackModel() : primaryModel(), state.runId)
    : await startAgentRun(id, `${state.instruction}\n\nPOPRAWKA - poprzednia wersja plików jest w repozytorium; popraw ją:\n${(await repairNotes(id, result, verification?.missing || [])).join("\n")}`, "system", 2, MODELS[state.model] || primaryModel(), state.runId);
  if ("error" in again) {
    console.warn(`[project-agent] ${id} retry did not start: ${again.error}`);
    return finished();
  }
  return again;
}

/** What to fix, from the failed requirements and placeholders (shown to the agent in a repair pass). */
async function repairNotes(id: string, r: RunResult, missing: string[]): Promise<string[]> {
  const notes: string[] = [];
  if (missing.length) notes.push(`- Brakuje plików (zapisz dokładnie pod tymi nazwami): ${missing.join(", ")}.`);
  if (r.unknownPlaceholders.length) notes.push(`- Użyto znaczników, które nie istnieją: ${r.unknownPlaceholders.join(", ")}. Usuń je (nie podpisuj wiadomości, nie wstawiaj danych, których nie ma).`);
  if (r.alteredPlaceholders.length) notes.push(`- Zmienione znaczniki: ${r.alteredPlaceholders.join(", ")}. Przepisz je dokładnie, z nawiasami.`);
  for (const q of await listRequirements(id)) {
    // Only this agent's own checks (other project steps, e.g. a quick estimate, add their own requirements).
    const own = (q.id.startsWith("sys-agent") || q.id.startsWith("spec-")) && !["sys-agent-files", "sys-agent-pii", "sys-agent-run"].includes(q.id);
    if (q.status === "failed" && own) notes.push(`- Niespełnione: ${q.text} (${q.evidence})`);
  }
  return notes;
}

/** File names the instruction asks for (words with a text-file extension), e.g. "kosztorys.csv". */
export function requestedFiles(instruction: string): string[] {
  const out = new Set<string>();
  const seps = " \t\n\r,;:()[]{}\"'`<>!?";
  let word = "";
  const flush = () => {
    let w = word;
    while (w.endsWith(".")) w = w.slice(0, -1);
    const dot = w.lastIndexOf(".");
    const ext = dot > 0 ? w.slice(dot + 1).toLowerCase() : "";
    if (["csv", "txt", "md", "json"].includes(ext) && !w.startsWith(".") && !w.includes("..")) out.add(w);
    word = "";
  };
  for (const ch of instruction) {
    if (seps.includes(ch)) flush();
    else word += ch;
  }
  flush();
  return [...out];
}

function kindOf(path: string): FileKind {
  const ext = path.split(".").pop()?.toLowerCase();
  return ext === "csv" ? "csv" : ext === "json" ? "json" : ext === "md" ? "md" : "txt";
}

function report(state: AgentRunState, r: RunResult): string {
  return [
    `# Agent run ${r.runId}`,
    `- model: ${state.model} (attempt ${state.attempt})`,
    `- instruction: ${state.instruction}`,
    `- result: ${r.state} (${r.stopReason})${r.error ? ` - ${r.error.slice(0, 300)}` : ""}`,
    `- steps: ${r.usage.steps}, tool calls: ${r.usage.toolCalls} (errors ${r.usage.toolErrors}), cost: $${r.usage.costUsd.toFixed(4)}`,
    `- personal data masked: ${r.piiMasked}; unknown placeholders: ${r.unknownPlaceholders.join(", ") || "none"}; altered: ${r.alteredPlaceholders.join(", ") || "none"}`,
    `- files: ${r.files.map((f) => f.path).join(", ") || "none"}${r.skippedFiles.length ? `; skipped (too large/many): ${r.skippedFiles.join(", ")}` : ""}`,
    "",
    "## Final message",
    r.finalText || "(none)",
    "",
  ].join("\n");
}

// ── Verification (code + Jev) ──

/** Numbers in a text: digit runs, a space between digit groups as a thousands separator, "," or "." decimals. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  const chars = [...text, " "];
  let cur = "";
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const isDigit = ch >= "0" && ch <= "9";
    if (isDigit) { cur += ch; continue; }
    const next3 = chars.slice(i + 1, i + 4);
    if (cur && (ch === " " || ch === " " || ch === " ") && next3.length === 3 && next3.every((c) => c >= "0" && c <= "9") && !(chars[i + 4] >= "0" && chars[i + 4] <= "9")) continue;
    if (cur && (ch === "," || ch === ".") && chars[i + 1] >= "0" && chars[i + 1] <= "9" && !cur.includes(".")) {
      // "2,352.00" / "2.352,00": a separator followed by exactly three digits and then the other separator
      // is a thousands separator; otherwise it is the decimal point.
      const d3 = chars.slice(i + 1, i + 4).every((c) => c >= "0" && c <= "9");
      const other = ch === "," ? "." : ",";
      if (d3 && chars[i + 4] === other && chars[i + 5] >= "0" && chars[i + 5] <= "9") continue;
      cur += ".";
      continue;
    }
    if (cur) { const n = Number(cur); if (Number.isFinite(n)) out.push(n); }
    cur = "";
  }
  return out;
}

/**
 * Calculations written out in a text ("12 zł/m2 × 150 m2 × 3 tygodnie = 5400 zł", "330 + 80 = 410 zł")
 * recomputed by code. A character scanner: numbers (a digit run glued to a letter, as in "m2", belongs to
 * the word), the operators × x * + and "=", any words between them (units) ignored. Returns the wrong ones.
 */
export function wrongCalculations(text: string): { expr: string; stated: number; actual: number }[] {
  type Tok = { k: "num"; v: number; at: number } | { k: "op"; v: string } | { k: "eq" } | { k: "break" };
  const toks: Tok[] = [];
  const chars = [...text];
  const isDigit = (c?: string) => !!c && c >= "0" && c <= "9";
  const isLetter = (c?: string) => !!c && c.toLowerCase() !== c.toUpperCase();
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (isDigit(c) && !isLetter(chars[i - 1])) {
      let j = i, raw = "";
      while (j < chars.length) {
        const d = chars[j];
        if (isDigit(d)) { raw += d; j++; continue; }
        if ((d === " " || d === "\u00a0") && isDigit(chars[j + 1]) && isDigit(chars[j + 2]) && isDigit(chars[j + 3]) && !isDigit(chars[j + 4]) && raw.length <= 3 && !raw.includes(".")) { j++; continue; }
        if ((d === "," || d === ".") && isDigit(chars[j + 1]) && !raw.includes(".")) { raw += "."; j++; continue; }
        break;
      }
      if (isLetter(chars[j])) { i = j; continue; } // part of a word such as "2x" or a product code
      toks.push({ k: "num", v: Number(raw), at: i });
      i = j - 1;
    } else if (c === "×" || c === "*" || ((c === "x" || c === "X") && !isLetter(chars[i - 1]) && !isLetter(chars[i + 1]))) toks.push({ k: "op", v: "*" });
    else if (c === "+") toks.push({ k: "op", v: "+" });
    else if (c === "=") toks.push({ k: "eq" });
    else if (c === "\n" || c === ";" || c === "(" || c === ")") toks.push({ k: "break" });
  }
  const out: { expr: string; stated: number; actual: number }[] = [];
  for (let i = 0; i < toks.length; i++) {
    // An expression: num (op num)+ eq num, with no break in between.
    if (toks[i].k !== "num") continue;
    const terms: number[] = [(toks[i] as any).v];
    const ops: string[] = [];
    let j = i + 1;
    while (j + 1 < toks.length && toks[j].k === "op" && toks[j + 1].k === "num") { ops.push((toks[j] as any).v); terms.push((toks[j + 1] as any).v); j += 2; }
    if (!ops.length || toks[j]?.k !== "eq" || toks[j + 1]?.k !== "num") continue;
    // × before +
    let sum = 0, prod = terms[0];
    for (let k = 0; k < ops.length; k++) {
      if (ops[k] === "*") prod *= terms[k + 1];
      else { sum += prod; prod = terms[k + 1]; }
    }
    const actual = Math.round((sum + prod) * 100) / 100;
    const stated = (toks[j + 1] as any).v as number;
    if (Math.abs(actual - stated) > 0.011) out.push({ expr: `${terms.map((t, k) => (k ? ` ${ops[k - 1] === "*" ? "×" : "+"} ` : "") + t).join("")} = ${stated}`, stated, actual });
    i = j;
  }
  return out;
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], cell = "", quoted = false;
  const t = withoutBom(text);
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if (quoted) {
      if (ch === '"' && t[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ";") { row.push(cell); cell = ""; }
    else if (ch === "\n") { row.push(cell.endsWith("\r") ? cell.slice(0, -1) : cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const num = (s: string | undefined) => {
  const n = numbersIn(s || "");
  return n.length === 1 ? n[0] : null;
};

async function verifyOutputs(id: string, r: RunResult, instruction: string): Promise<{ met: number; failed: number; missing: string[]; customerOnlyFailed: boolean; specFailed: number }> {
  const text = (p: string) => r.files.find((f) => f.path === p && f.encoding === "utf-8")?.content;
  const results: { reqId: string; status: ReqStatus; evidence: string }[] = [];
  const req = async (reqId: string, textReq: string, check: string) => addRequirement(id, { id: reqId, text: textReq, source: "system", check });

  await req("sys-agent-run", "The agent finished the task within its limits (time, steps, cost).", "code");
  results.push({ reqId: "sys-agent-run", status: r.state === "succeeded" ? "met" : "failed", evidence: `${r.state} (${r.stopReason})${r.error ? `: ${r.error.slice(0, 200)}` : ""}` });

  await req("sys-agent-pii", "Personal data was masked for the agent and every placeholder came back unchanged.", "code");
  const piiOk = !r.unknownPlaceholders.length && !r.alteredPlaceholders.length;
  results.push({ reqId: "sys-agent-pii", status: piiOk ? "met" : "failed", evidence: piiOk ? `${r.piiMasked} values masked, all placeholders restored` : `unknown: ${r.unknownPlaceholders.join(", ")}; altered: ${r.alteredPlaceholders.join(", ")}` });

  // A requested file counts when the agent wrote it or it exists (non-empty) in the repository (an
  // instruction also names its input files).
  const spec = (await getProject(id))?.memory.plan as import("./plan.js").Spec | undefined;
  const wanted = (spec ? spec.outputs.map((o) => o.path) : requestedFiles(instruction)).filter((p) => p !== BUSINESS_QUESTIONS);
  const missing: string[] = [];
  for (const p of wanted) {
    if (r.files.some((f) => f.path === p && f.size > 0)) continue;
    const existing = await readFile(id, p).catch(() => null);
    if (!existing || !existing.trim()) missing.push(p);
  }
  if (wanted.length) {
    await req("sys-agent-files", `The files the task asks for exist: ${wanted.join(", ")}.`, "code");
    results.push({ reqId: "sys-agent-files", status: missing.length ? "failed" : "met", evidence: missing.length ? `missing: ${missing.join(", ")}` : "all present" });
  }

  // The businesses that must be asked (decided before the run) are in the requests to the network.
  const proj = await getProject(id);
  const mustAsk = ((proj?.memory.mustAsk as string[]) || []).filter(Boolean);
  if (mustAsk.length && !proj?.memory.networkAsked) {
    let asked: string[] = [];
    try {
      const raw = JSON.parse((await readFile(id, "zapytania_do_firm.json").catch(() => null)) || "[]");
      const slugs = (proj?.memory.businessSlugs as Record<string, string>) || {};
      asked = (Array.isArray(raw) ? raw : []).map((x: any) => slugs[String(x?.firma || "").trim()]).filter(Boolean);
    } catch { asked = []; }
    const notAsked = mustAsk.filter((t) => !asked.includes(t));
    const { businessLabel } = await import("./network.js");
    await req("sys-agent-network", `The businesses that must be asked for prices are asked: ${mustAsk.map(businessLabel).join(", ")}.`, "code");
    results.push({ reqId: "sys-agent-network", status: notAsked.length ? "failed" : "met", evidence: notAsked.length ? `not asked: ${notAsked.map(businessLabel).join(", ")} (zapytania_do_firm.json)` : "all asked" });
  }

  // Tables with a total row (first cell RAZEM / SUMA / TOTAL...): every number in that row must equal
  // the sum of the numbers above it in its column - for any kind of table the agent produced.
  const totals: number[] = [];
  const TOTAL_LABELS = ["razem", "suma", "łącznie", "lacznie", "total", "sum", "разом", "всього", "итого", "total général"];
  const badTotals: string[] = [];
  let tables = 0;
  // Only tables someone receives (customer files, files the task asked for) - the agent's own working
  // files (calculations listing alternatives) need not add up.
  const delivered = new Set(wanted);
  for (const f of r.files) {
    if (f.encoding !== "utf-8" || !f.path.toLowerCase().endsWith(".csv")) continue;
    if (!delivered.has(f.path) && !f.path.startsWith("dla_klienta/")) continue;
    const rows = csvRows(f.content).filter((row) => row.some((c) => c.trim()));
    rows.forEach((row, k) => {
      if (!TOTAL_LABELS.includes(row[0].trim().toLowerCase()) || k === 0) return;
      tables++;
      row.forEach((cell, col) => {
        if (col === 0) return;
        const t = num(cell);
        if (t === null) return;
        totals.push(t);
        let sum = 0;
        for (const above of rows.slice(1, k)) { const v = num(above[col]); if (v !== null) sum += Math.round(v * 100); }
        if (Math.abs(t * 100 - sum) >= 1) badTotals.push(`${f.path} column ${(rows[0][col] || col).toString().trim()}: ${t} != ${sum / 100}`);
      });
    });
  }
  if (tables) {
    await req("sys-agent-totals", "Totals in the produced tables equal the sums of their columns.", "code");
    results.push({ reqId: "sys-agent-totals", status: badTotals.length ? "failed" : "met", evidence: badTotals.join("; ") || `${tables} total row(s) checked` });
  }

  const reply = text("odpowiedz.txt");
  if (reply) {
    // Calculation outputs and data count as sources of numbers; the agent's own scripts do not (a number
    // typed into a script as text is not a calculation).
    const sources = r.files.filter((f) => f.encoding === "utf-8" && f.path !== "odpowiedz.txt" && !f.path.endsWith(".py") && !f.path.endsWith(".js") && !f.path.endsWith(".sh")).map((f) => f.content);
    const inputs = await inputTexts(id);
    const customer = inputs.request || "";
    // Language: the customer's, checked by Jev.
    await req("sys-agent-language", "The reply is written in the customer's language.", "jev");
    const lang = await customerLanguage(customer);
    if (lang) {
      const a = await jevAsk({ text: reply.slice(0, 3000) }, { l: { type: "noul", instructions: `Is \`text\` written in ${LANGS[lang] || lang}?` } }, 8000);
      const p = (a?.l as any)?.noul as number | undefined;
      results.push({ reqId: "sys-agent-language", status: p === undefined ? "open" : p >= 0.5 ? "met" : "failed", evidence: `customer: ${lang}; P(reply in it) = ${p?.toFixed(2) ?? "n/a"}` });
    } else results.push({ reqId: "sys-agent-language", status: "open", evidence: "customer language unknown" });
    // Scripts: none the customer or the offer data do not use (e.g. Chinese characters in Polish).
    await req("sys-agent-script", "The reply uses no writing system foreign to the customer and the offer.", "code");
    const { strayScripts } = await import("../flows/collect.js");
    const stray = strayScripts(customer + "\n" + inputs.all, reply);
    results.push({ reqId: "sys-agent-script", status: stray.length ? "failed" : "met", evidence: stray.length ? `foreign scripts: ${stray.join(", ")}` : "ok" });
    // Calculations written out for the customer are recomputed (the agent once wrote "12 × 150 × 3 = 6300").
    await req("sys-agent-arithmetic", "Every calculation written out in the reply is correct.", "code");
    const wrong = wrongCalculations(reply);
    results.push({ reqId: "sys-agent-arithmetic", status: wrong.length ? "failed" : "met", evidence: wrong.length ? wrong.map((w) => `${w.expr} (should be ${w.actual})`).join("; ") : "ok" });
    // Numbers: every number in the reply appears in the project's data or the agent's files.
    await req("sys-agent-numbers", "Every number in the reply comes from the project's data or calculations.", "code");
    const known = new Set<number>();
    for (const t of [...sources, inputs.all]) for (const n of numbersIn(t)) known.add(Math.round(n * 100));
    const unsupported = [...new Set(numbersIn(reply).filter((n) => !known.has(Math.round(n * 100))))];
    results.push({ reqId: "sys-agent-numbers", status: unsupported.length ? "failed" : "met", evidence: unsupported.length ? `not in any file: ${unsupported.join(", ")}` : "ok" });
    // The reply is final for the customer: questions and notes for the business go to the business.
    await req("sys-agent-customer-only", `The text for the customer has no questions or notes meant for the business (those belong in ${BUSINESS_QUESTIONS}).`, "jev");
    await req("sys-agent-no-promise", "The text for the customer promises no follow-up that nothing guarantees (\"I'll update it when...\", \"the business will get back to you\").", "jev");
    const cq = await jevAsk({ text_for_customer: reply.slice(0, 3000) }, {
      b: { type: "noul", instructions: "Does `text_for_customer` contain anything meant for the business rather than the customer: a question to the business or its staff, a request that the business confirms or checks something, an internal note about assumptions the business should verify, or instructions for the business? Telling the customer what is unknown or still to be agreed with the business is fine and does not count." },
      p: { type: "noul", instructions: "Does `text_for_customer` promise a later action: that the assistant will update, complete or send something later, or that the business will contact the customer, get back to them or send something? Saying what the customer can do (e.g. ask the business) is fine and does not count." },
    }, 8000);
    const pb = (cq?.b as any)?.noul as number | undefined;
    results.push({ reqId: "sys-agent-customer-only", status: pb === undefined ? "open" : pb < 0.5 ? "met" : "failed", evidence: `P(content for the business) = ${pb?.toFixed(2) ?? "n/a"}` });
    const pp = (cq?.p as any)?.noul as number | undefined;
    results.push({ reqId: "sys-agent-no-promise", status: pp === undefined ? "open" : pp < 0.5 ? "met" : "failed", evidence: `P(promises a follow-up) = ${pp?.toFixed(2) ?? "n/a"}` });
    if (totals.length) {
      await req("sys-agent-reply-total", "The text for the customer states the total of the produced tables.", "code");
      const has = numbersIn(reply).some((n) => totals.some((t) => Math.abs(n - t) < 0.005));
      results.push({ reqId: "sys-agent-reply-total", status: has ? "met" : "failed", evidence: `totals ${totals.join(", ")} ${has ? "stated" : "not stated"}` });
    }
  }
  // The spec's acceptance criteria, judged by Jev against the outputs (trimmed).
  if (spec?.acceptance.length) {
    const outputsText = r.files.filter((f) => f.encoding === "utf-8" && wanted.includes(f.path)).map((f) => `### ${f.path}\n${f.content.slice(0, 4000)}`).join("\n\n").slice(0, 14000);
    const qs: Record<string, { type: "noul"; instructions: string }> = {};
    spec.acceptance.forEach((a, k) => { qs[`a${k}`] = { type: "noul", instructions: `Do \`outputs\` meet this criterion: "${a}"?` }; });
    const ans = outputsText ? await jevAsk({ outputs: outputsText }, qs, 10000) : null;
    for (const [k, a] of spec.acceptance.entries()) {
      const pa = (ans as any)?.[`a${k}`]?.noul as number | undefined;
      await req(`spec-${k + 1}`, a, "jev");
      results.push({ reqId: `spec-${k + 1}`, status: pa === undefined ? "open" : pa >= 0.5 ? "met" : "failed", evidence: `P = ${pa?.toFixed(2) ?? "n/a"} (spec v${spec.version})` });
    }
  }
  const customerOnlyFailed = results.some((x) => x.reqId === "sys-agent-customer-only" && x.status === "failed");
  // The spec's criteria are judged by a model: soft - they trigger a repair pass, but do not hold back a
  // result that passes every hard check.
  const specFailed = results.filter((x) => x.reqId.startsWith("spec-") && x.status === "failed").length;
  return { ...(await recordVerification(id, results, "system", "agent/verification.json")), missing, customerOnlyFailed, specFailed };
}

async function inputTexts(id: string): Promise<{ request: string | null; all: string }> {
  const files = await listFiles(id);
  let all = "";
  let request: string | null = null;
  for (const f of files) {
    if (f.author.startsWith("agent:") || f.size > MAX_INPUT_FILE || !["csv", "txt", "md", "json"].includes(f.kind)) continue;
    const t = await readFile(id, f.path);
    if (t === null) continue;
    if (f.path === "request.txt") request = t;
    all += t + "\n";
  }
  return { request, all };
}

const langMemo = new Map<string, string | null>();
async function customerLanguage(text: string): Promise<string | null> {
  if (!text.trim()) return null;
  const key = text.slice(0, 500);
  if (langMemo.has(key)) return langMemo.get(key)!;
  const a = await jevAsk({ text: text.slice(0, 2000) }, { lang: { type: "choice", instructions: "Which language is `text` written in?", criteria: LANGS } }, 8000);
  const choice = (a?.lang as any)?.choice as string | undefined;
  const lang = choice && choice !== "other" ? choice : null;
  if (langMemo.size > 500) langMemo.clear();
  langMemo.set(key, lang);
  return lang;
}
