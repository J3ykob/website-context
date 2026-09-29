import { describe, it, expect } from "vitest";
import { startSession, collectTurn, strayScripts, type CollectResult } from "../src/flows/collect.js";
import { jevAsk } from "../src/llm/jev.js";
import type { FlowDefinition } from "../src/context/types.js";

// Live: the production answer model (OpenRouter) and Jev. Skipped without keys.
// Every language a customer may write in is a standard case: the whole order is
// taken in that language, nothing is sent before the summary is confirmed, and no
// reply mixes in another writing system.
const live = process.env.OPENROUTER_API_KEY && process.env.JEV_API_KEY ? describe : describe.skip;
const MODEL = process.env.OPENROUTER_MODEL || "qwen/qwen3-235b-a22b-2507";

const llm = async (system: string, user: string, maxTokens = 700): Promise<string> => {
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0.2, max_tokens: maxTokens, messages: [{ role: "system", content: system }, { role: "user", content: user }] }),
  });
  return ((await r.json()) as any).choices[0].message.content;
};

// A tile shop's own knowledge (the offer check reads it).
const OFFER = [
  "Płytki gresowe Tubądzin Grand Cave brown STR 59,8x59,8 oraz Grand Cave ivory STR 79,8x79,8 - kolekcja Grand Cave w salonie Romax.",
  "Kabiny prysznicowe: Radaway kabina prysznicowa 90x90, Mazo drzwi kabiny kwadrat 90x90.",
  "Grzejniki łazienkowe drabinkowe w wielu rozmiarach i kolorach.",
];
const knowledge = () => OFFER;

const flow: FlowDefinition = {
  id: "collect_test", name: "Zamówienie ze sklepu", status: "active", executionMode: "collect",
  description: "Przyjmij zamówienie ze sklepu: jakie produkty z naszej oferty i w jakiej ilości, termin i adres dostawy, imię i nazwisko oraz telefon klienta.",
  triggerPhrases: [], steps: [], createdAt: "", updatedAt: "",
  requiredInputs: [
    { name: "products", label: "Produkty i ilość", type: "select", required: true, description: "products from our offer, with quantities" },
    { name: "delivery_address", label: "Adres dostawy", type: "text", required: true, description: "" },
    { name: "delivery_date", label: "Termin dostawy", type: "text", required: true, description: "" },
    { name: "full_name", label: "Imię i nazwisko", type: "text", required: true, description: "" },
    { name: "phone", label: "Telefon", type: "text", required: true, description: "" },
  ],
};

const LANGS = { pl: "Polish", en: "English", uk: "Ukrainian", fr: "French" } as const;
type Lang = keyof typeof LANGS;
async function languageOf(text: string): Promise<string | undefined> {
  const a: any = await jevAsk({ text }, { lang: { type: "choice", instructions: "In which language is `text` written?", criteria: { ...LANGS, other: "Any other language" } } }, 8000);
  return a?.lang?.choice;
}

/** Runs a conversation; checks every reply's language and script; returns the last result. */
async function converse(lang: Lang, messages: string[], firstConfirm = messages.length - 1): Promise<{ last: CollectResult; replies: string[] }> {
  const s = startSession(flow);
  const replies: string[] = [];
  let last: CollectResult = { reply: "" };
  for (let k = 0; k < messages.length; k++) {
    last = await collectTurn(flow, s, messages[k], "Romax", llm, knowledge);
    replies.push(last.reply);
    expect(strayScripts(messages[k], last.reply), `stray script in: ${last.reply}`).toEqual([]);
    expect(await languageOf(last.reply), `not ${LANGS[lang]}: ${last.reply}`).toBe(lang);
    if (k < firstConfirm) expect("inquiry" in last, "sent before the customer confirmed").toBe(false);
    if ("inquiry" in last || "cancelled" in last) break;
  }
  return { last, replies };
}

const ORDERS: Record<Lang, string[]> = {
  pl: ["Dzień dobry, chcę zamówić 30 m2 płytek Grand Cave brown STR 59,8x59,8", "Dostawa w piątek, Ząbki, ul. Kwiatowa 5", "Jan Kowalski, 500 600 700", "tak, zgadza się"],
  en: ["Hi, I'd like to order 30 m2 of Grand Cave brown STR 59.8x59.8 tiles", "Delivery on Friday to Ząbki, Kwiatowa 5", "John Smith, 500 600 700", "yes, that's correct"],
  uk: ["Добрий день, хочу замовити 30 м2 плитки Grand Cave brown STR 59,8x59,8", "Доставка в п'ятницю, Ząbki, вул. Kwiatowa 5", "Олег Коваленко, 500 600 700", "так, все правильно"],
  fr: ["Bonjour, je voudrais commander 30 m2 de carrelage Grand Cave brown STR 59,8x59,8", "Livraison vendredi à Ząbki, ul. Kwiatowa 5", "Marie Dubois, 500 600 700", "oui, c'est correct"],
};

live("chat forms: a whole order in the customer's language", () => {
  for (const lang of Object.keys(ORDERS) as Lang[]) {
    it(`${LANGS[lang]}`, async () => {
      const { last } = await converse(lang, ORDERS[lang]);
      expect("inquiry" in last, `no inquiry after confirming (${LANGS[lang]})`).toBe(true);
      const values = "inquiry" in last ? last.inquiry.fields.map((f) => f.value).join(" | ") : "";
      expect(values).toContain("500 600 700");
      expect(values).toContain("Kwiatowa 5");
    }, 180000);
  }

  it("French: a mixed order (one item not in the offer) does not loop when the customer moves on", async () => {
    const { last } = await converse("fr", [
      "Bonjour, je voudrais 30 m2 de carrelage Grand Cave et 10 sacs de ciment Górażdże",
      "Livraison lundi prochain à Varsovie, ul. Marszałkowska 10",
      "Marie Dubois, +33 6 12 34 56 78",
      "oui, c'est correct",
      "oui",
    ], 3);
    expect("inquiry" in last, "the order never completed").toBe(true);
  }, 240000);
});
