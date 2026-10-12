import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createProject, addParticipant } from "../src/projects/store.js";
import { writeFile, listFiles, readFile, listRequirements } from "../src/projects/repo.js";
import { startAgentRun, agentStatus, numbersIn, type AgentRunState } from "../src/projects/agent.js";
import { hydrateRegistry } from "../src/multi-tenant/d1-registry.js";
import { d1Query } from "../src/storage/conversation-store.js";

// Live, end to end: D1 + R2 (the project), the project-agent runner (PROJECT_AGENT_URL: `wrangler dev`
// in workers/project-agent, or the deployed Worker), OpenRouter (the agent's model), Jev (checks).
// Real offers of two tenants (Rentbud rental rates, Ostap shop prices); totals are exact.
// Standard languages: PL, EN, UK, FR. Each request carries personal data, which must be masked for the
// agent and restored in its outputs.
const live = process.env.PROJECT_AGENT_URL && process.env.PROJECT_AGENT_SECRET && process.env.JEV_API_KEY && process.env.CF_API_TOKEN ? describe : describe.skip;

const CASES: { lang: string; request: string; total: number; phone: string; email: string }[] = [
  { lang: "Polish", request: "Dzień dobry, jestem Anna Kowalska (tel. 601 234 567, anna.kowalska@wp.pl). Potrzebuję zagęszczarkę 90 kg na 3 dni i betoniarkę 150 litrów na 5 godzin. Ile to wyjdzie?", total: 410, phone: "601 234 567", email: "anna.kowalska@wp.pl" },
  { lang: "English", request: "Hi, this is John Mitchell, +48 512 345 678, john.mitchell@gmail.com. I'd like to rent the Hilti DCH 180 wall chaser for 2 days and an inverter welder for 6 hours. What would it cost?", total: 490, phone: "+48 512 345 678", email: "john.mitchell@gmail.com" },
  { lang: "Ukrainian", request: "Добрий день! Мене звати Олена Шевченко, телефон 733 222 111, olena.shevchenko@ukr.net. Потрібна віброплита (ущільнювач) 130 кг на 4 дні та водяний насос 600 л на 3 години. Скільки це коштуватиме?", total: 620, phone: "733 222 111", email: "olena.shevchenko@ukr.net" },
  { lang: "French", request: "Bonjour, je suis Claire Dubois (06 12 34 56 78, claire.dubois@orange.fr). Je voudrais louer une remorque de voiture pour 2 jours et un décapeur thermique pour 10 heures. Quel serait le prix ?", total: 170, phone: "06 12 34 56 78", email: "claire.dubois@orange.fr" },
];
const INSTRUCTION = "Przygotuj wycenę dla klienta (kosztorys.csv i odpowiedz.txt). Zapisz też dane_klienta.txt: imię i nazwisko, telefon i e-mail klienta, po jednym w linii.";

const ids: string[] = [];
beforeAll(async () => { await hydrateRegistry(); });
afterAll(async () => {
  const { deleteFromR2 } = await import("../src/storage/r2.js");
  for (const id of ids) {
    for (const f of await listFiles(id).catch(() => [])) await deleteFromR2(`projects/${id}/${f.path}`).catch(() => {});
    for (const t of ["project_events", "project_participants", "project_consents", "project_files", "project_requirements"]) await d1Query(`DELETE FROM ${t} WHERE project_id = ?`, [id]);
    await d1Query("DELETE FROM projects WHERE id = ?", [id]);
  }
}, 120_000);

async function waitDone(id: string, ms = 15 * 60 * 1000): Promise<AgentRunState> {
  const end = Date.now() + ms;
  for (;;) {
    const s = await agentStatus(id);
    if (s && (s.status === "done" || s.status === "failed")) return s;
    if (Date.now() > end) throw new Error(`agent run timed out: ${JSON.stringify(s)}`);
    await new Promise((ok) => setTimeout(ok, 10_000));
  }
}

// Not only quotes: projects are open-ended. Each case: the customer's (or owner's) message, the task,
// and an exact check of the result computed from the real offers.
const OTHER: { name: string; request: string; instruction: string; check: (read: (p: string) => Promise<string | null>) => Promise<void> }[] = [
  {
    name: "budget choice",
    request: "Mam 500 zł budżetu i potrzebuję zagęszczarkę na 2 dni. Jaką najcięższą zagęszczarkę (nie ubijak) mogę wziąć, żeby się zmieścić? Pozdrawiam, Piotr Nowak",
    instruction: "Odpowiedz klientowi (odpowiedz.txt) i zapisz wynik.json {\"pozycja\": nazwa z cennika, \"koszt\": liczba}.",
    check: async (read) => {
      const j = JSON.parse((await read("wynik.json")) || "{}");
      expect(j.pozycja).toBe("Zagęszczarka 280 kg");
      expect(Number(j.koszt)).toBe(460);
    },
  },
  {
    name: "rent or buy",
    request: "Opłaca mi się bardziej wynająć wciągarkę w Rentbud czy kupić wciągarkę montażową w Ostapie? Od ilu pełnych dni wynajmu zakup jest tańszy?",
    instruction: "Odpowiedz klientowi (odpowiedz.txt) i zapisz wynik.json {\"od_ilu_dni_zakup_tanszy\": liczba całkowita}.",
    check: async (read) => {
      const j = JSON.parse((await read("wynik.json")) || "{}");
      expect(Number(j.od_ilu_dni_zakup_tanszy)).toBe(3);
    },
  },
  {
    name: "owner data task",
    request: "(wiadomość od właściciela firmy Ostap) Przygotuj mi listę pozycji z mojej oferty, które nie mają żadnej ceny, żebym mógł je uzupełnić.",
    instruction: "Zapisz do_uzupelnienia.csv (kolumny: id;nazwa) - wszystkie pozycje oferty Ostap bez ceny (pusta cena i brak składników ceny). Bez tekstu dla klienta.",
    check: async (read) => {
      const { loadOffer } = await import("../src/offer/store.js");
      const offer = await loadOffer("www_ostap_pl");
      const expected = new Set(offer.items.filter((i) => i.price_value === null && !i.components.some((c) => c.price_value !== null) && !["on_request", "free", "included"].includes(i.fields.price_type || "")).map((i) => i.id.slice(0, 8)));
      const rows = ((await read("do_uzupelnienia.csv")) || "").split("\n").slice(1).map((l) => l.split(";")[0].trim()).filter(Boolean);
      expect(new Set(rows)).toEqual(expected);
    },
  },
];

live("project agent: sandboxed run with masked personal data", () => {
  for (const c of CASES) {
    it(c.lang, async () => {
      const p = await createProject("compare_offers@1", { customerSession: `test-agent-${Date.now()}`, initiatorTenantId: "www_rentbud_pl", title: `agent test ${c.lang}` });
      ids.push(p.id);
      await addParticipant(p.id, "www_ostap_pl", "quoting");
      await writeFile(p.id, "request.txt", c.request, "txt", "customer");

      const started = await startAgentRun(p.id, INSTRUCTION, "test");
      expect("error" in started ? started.error : "").toBe("");
      const s = await waitDone(p.id);
      const reqs = await listRequirements(p.id);
      const failed = reqs.filter((r) => r.status !== "met").map((r) => `${r.id}: ${r.status} ${r.evidence}`);
      const kosztorys = await readFile(p.id, "kosztorys.csv");
      const reply = await readFile(p.id, "odpowiedz.txt");
      const person = await readFile(p.id, "dane_klienta.txt");
      console.log(`[${c.lang}] ${s.status} ${s.model} $${s.costUsd} files=${s.files?.join(",")}\n${kosztorys}\n${reply}\n${person}\n${failed.join("\n")}`);

      expect(s.status).toBe("done");
      expect(failed).toEqual([]);
      expect(numbersIn(reply || "").some((n) => Math.abs(n - c.total) < 0.005)).toBe(true);
      // Personal data came back as the real values (masked inside the sandbox).
      expect(person).toContain(c.phone);
      expect(person).toContain(c.email);
      expect(person || "").not.toContain("[");
    }, 20 * 60 * 1000);
  }
});

live("project agent: other kinds of projects", () => {
  for (const c of OTHER) {
    it(c.name, async () => {
      const p = await createProject("compare_offers@1", { customerSession: `test-agent-${Date.now()}`, initiatorTenantId: "www_rentbud_pl", title: `agent test ${c.name}` });
      ids.push(p.id);
      await addParticipant(p.id, "www_ostap_pl", "quoting");
      await writeFile(p.id, "request.txt", c.request, "txt", "customer");
      const started = await startAgentRun(p.id, c.instruction, "test");
      expect("error" in started ? started.error : "").toBe("");
      const s = await waitDone(p.id);
      const failed = (await listRequirements(p.id)).filter((r) => r.status !== "met").map((r) => `${r.id}: ${r.status} ${r.evidence}`);
      console.log(`[${c.name}] ${s.status} attempt ${s.attempt} ${s.model} $${s.costUsd} files=${s.files?.join(",")}\n${failed.join("\n")}`);
      expect(s.status).toBe("done");
      expect(failed).toEqual([]);
      await c.check((path) => readFile(p.id, path));
    }, 20 * 60 * 1000);
  }
});
