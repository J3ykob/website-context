import { describe, it, expect } from "vitest";
import { jevPassageRelevance, jevPickOption } from "../src/llm/jev.js";

// Live TypeSafe API: real passages from www.amygdala.pl. Skipped without JEV_API_KEY.
const live = process.env.JEV_API_KEY ? describe : describe.skip;

const HOURS = "Warszawa Targówek. ul. Barkocińska 6 lok. 10 (1 piętro). +48 739 942 023. pon.-pt. 8:00-17:00, sobota nieczynne, niedziela nieczynne.";
const PRICES = "Cennik. Badanie psychotechniczne 150 zł - kierowcy wszystkich kategorii, cena ustawowa. Lekarz medycyny pracy 150 zł - wizyta z orzeczeniem. Badanie lekarskie kierowców 280 zł - kat. C, C+E, D, D+E z okulistą.";
const REVIEWS = "Opinie pacjentów. Szybko i profesjonalnie, badanie online trwało 20 minut. Polecam!";

live("jevPassageRelevance (answerability gate)", () => {
  it("scores the passage that holds the fact high and unrelated ones low", async () => {
    const r = await jevPassageRelevance("Do której jest otwarte na Targówku?", [REVIEWS, HOURS, PRICES]);
    expect(r).not.toBeNull();
    expect(r![1]).toBeGreaterThan(0.7);
    expect(r![0]).toBeLessThan(0.3);
  }, 15000);
  it("keeps every passage low when the site does not answer", async () => {
    const r = await jevPassageRelevance("Czy robicie rezonans magnetyczny głowy?", [REVIEWS, HOURS, PRICES]);
    expect(Math.max(...r!)).toBeLessThan(0.3);
  }, 15000);
  it("finds a price inside a longer price list", async () => {
    const r = await jevPassageRelevance("Ile kosztują badania dla kierowcy kategorii C?", [HOURS, PRICES]);
    expect(r![1]).toBeGreaterThan(0.7);
  }, 15000);
});

live("jevPickOption (flow routing)", () => {
  const flows = ["Umów wizytę: rezerwacja terminu badania", "Zamów badania dla firmy: formularz dla pracodawców"];
  const ask = (m: string) => jevPickOption(
    "Does the visitor's `message` ask to START one of these actions right now? Choose none if they only ask a question, ask about price or info, greet, or chat.",
    m, flows, "Just asking a question, asking about price or information, greeting, chatting, or none apply.");
  it("routes a clear booking request", async () => {
    expect((await ask("Chcę się umówić na badanie na jutro"))!.index).toBe(0);
  }, 15000);
  it("does not start a flow for a price question", async () => {
    expect((await ask("Ile kosztuje badanie psychotechniczne?"))!.index).toBe(-1);
  }, 15000);
});

describe("jev fallbacks", () => {
  it("returns null without a key so callers fall back", async () => {
    const saved = process.env.JEV_API_KEY;
    delete process.env.JEV_API_KEY;
    try {
      expect(await jevPassageRelevance("q", ["p"])).toBeNull();
      expect(await jevPickOption("i", "m", ["a"], "none")).toBeNull();
    } finally { if (saved) process.env.JEV_API_KEY = saved; }
  });
});

live("jevIsKnowledgeGap", () => {
  it("flags real questions about the business and ignores small talk and off-topic", async () => {
    const { jevIsKnowledgeGap } = await import("../src/llm/jev.js");
    const [mri, parking, hi, thanks, capital] = await Promise.all([
      jevIsKnowledgeGap("Czy robicie rezonans magnetyczny głowy?"),
      jevIsKnowledgeGap("Czy jest parking przy placówce na Ursynowie?"),
      jevIsKnowledgeGap("Cześć!"),
      jevIsKnowledgeGap("Dzięki, to wszystko"),
      jevIsKnowledgeGap("Jaka jest stolica Francji?"),
    ]);
    expect(mri!).toBeGreaterThan(0.5);
    expect(parking!).toBeGreaterThan(0.5);
    expect(hi!).toBeLessThan(0.5);
    expect(thanks!).toBeLessThan(0.5);
    expect(capital!).toBeLessThan(0.5);
  }, 20000);
});
