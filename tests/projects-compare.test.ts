import { describe, it, expect, afterAll } from "vitest";
import { runCompare, type Business } from "../src/projects/compare.js";
import { clean } from "../src/offer/store.js";
import { d1Query } from "../src/storage/conversation-store.js";

// Live: OpenRouter (parsing + wording), Jev (matching) and D1 (the project).
// Fixed offers, so totals are exact. Standard languages: PL, EN, UK, FR.
const live = process.env.OPENROUTER_API_KEY && process.env.JEV_API_KEY && process.env.CF_API_TOKEN ? describe : describe.skip;

const rates = (h: number, d: number) => [
  { label: "Stawka godzinowa", price_type: "per_unit", price_value: h, unit: "godzina", combine: "alternative" },
  { label: "Stawka dobowa", price_type: "per_unit", price_value: d, unit: "doba", combine: "alternative" },
];
const rental: Business = { tenantId: "test_rental", label: "Wypożyczalnia Test", items: [
  { name: "Zagęszczarka 90 kg", category: "Zagęszczarki", price_value: 22, fields: { kind: "rental", price_type: "per_unit", unit: "godzina" }, components: rates(22, 110) },
  { name: "Betoniarka 150 litrów", category: "Betoniarki", price_value: 16, fields: { kind: "rental", price_type: "per_unit", unit: "godzina" }, components: rates(16, 80) },
  { name: "Młot wyburzeniowy 30 kg", category: "Młoty", price_value: 20, fields: { kind: "rental", price_type: "per_unit", unit: "godzina" }, components: rates(20, 100) },
].map((x) => clean(x, "manual")!) };
const scaffold: Business = { tenantId: "test_scaffold", label: "Rusztowania Test", items: [
  clean({ name: "Rusztowanie elewacyjne", category: "Rusztowania", fields: { kind: "rental", price_type: "on_request" } }, "manual")!,
] };

const llm = async (system: string, user: string, maxTokens = 900): Promise<string> => {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", { signal: AbortSignal.timeout(60000), method: "POST", headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" }, body: JSON.stringify({ model: process.env.OPENROUTER_MODEL || "qwen/qwen3-235b-a22b-2507", temperature: 0, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }) });
  return ((await r.json()) as any).choices[0].message.content;
};

const ids: string[] = [];
afterAll(async () => {
  for (const id of ids) {
    for (const t of ["project_events", "project_participants", "project_consents"]) await d1Query(`DELETE FROM ${t} WHERE project_id = ?`, [id]);
    await d1Query("DELETE FROM projects WHERE id = ?", [id]);
  }
});

const CASES: [string, string, number, number][] = [
  ["Polish", "Ile zapłacę za wynajem zagęszczarki 90 kg na 3 doby i betoniarki 150 l na 2 doby, plus rusztowanie elewacyjne?", 490, 1],
  ["English", "How much to rent a 90 kg plate compactor for 3 days and a demolition hammer for 1 day?", 430, 0],
  ["Ukrainian", "Скільки коштує оренда бетонозмішувача 150 л на 2 доби і віброплити 90 кг на 3 доби?", 490, 0],
  ["French", "Combien coûte la location d'une bétonnière 150 l pour 2 jours et d'un marteau-piqueur pour 1 jour ?", 260, 0],
];

live("compare_offers@1: a list priced across the network", () => {
  for (const [lang, msg, total, tbd] of CASES) {
    it(lang, async () => {
      const r = await runCompare({ message: msg, customerSession: "test-suite", askingTenantId: "test_rental", businesses: [rental, scaffold], llm, language: lang });
      expect(r, "no result").not.toBeNull();
      ids.push(r!.projectId);
      expect(r!.total, JSON.stringify(r!.lines.map((l) => [l.line.need, l.status, l.assigned?.item, l.assigned?.total]))).toBe(total);
      expect(r!.tbdLines).toBe(tbd);
      expect(r!.message.length).toBeGreaterThan(20);
    }, 200000);
  }
});
