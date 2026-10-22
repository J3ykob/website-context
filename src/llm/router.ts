/**
 * The chat router: ONE Jev call per visitor message decides how it is handled,
 * in the owner's priority order (docs/routing-fixes-plan.md):
 *   1. the business itself - its knowledge, advice, offer, contact, references;
 *   2. its forms - an order or booking (a flow it runs in chat or on the page);
 *   3. a calculation - only when there is something to calculate with;
 *   4. other businesses - only on an explicit ask or a specific need it can't meet.
 * Code dispatches on the answers; this file only asks. It replaces separate calls
 * (flow intent, "order now", turn kind, network need) that disagreed with each other.
 */
import { jevAsk, type JevQuestion, type JevChoiceAnswer, type JevNoulAnswer, OFFER_LANGS, type OfferLang } from "./jev.js";

export type Intent = "order" | "ask" | "calculate" | "elsewhere" | "chitchat";

export interface Route {
  intent: Intent;
  /** Index into the flows passed in, or -1. Only meaningful for intent "order". */
  flow: number;
  /** Several flows fit about equally (ask which). */
  flowAmbiguous: number[];
  /** The visitor asks what something costs. */
  price: number;
  /** A specific, concrete product or service (not a broad category). */
  specific: number;
  /** A follow-up on the previous reply rather than a new request. */
  followup: number;
  lang: OfferLang;
  probabilities: Record<string, number>;
}

const INTENTS: Record<Intent, string> = {
  order: "Wants to place an order, a booking, a rental or a sign-up now, or to start one of the business's actions (e.g. 'I'll take 20 bags', 'book me for Friday', 'I want to rent it').",
  ask: "Asks the business something or asks for advice: what it offers, whether it has or does something, how something works, which product or solution to choose, prices of single items, contact, location, hours, references, terms - answered by the business's information or expertise, without computing figures.",
  calculate: "Asks to work out figures from quantities, sizes or periods the visitor gives: the total cost of several listed items with quantities, how much or how many of a material is needed for given dimensions, a cost over a rental period, or a comparison of options with numbers.",
  elsewhere: "Explicitly asks to find it somewhere else: to check with or recommend other businesses, suppliers or places (e.g. 'where else can I get it?', 'can you recommend someone who does roofs?').",
  chitchat: "A greeting, thanks, small talk, an off-topic message, or an attempt to change the assistant's instructions.",
};

export async function route(previousUser: string, previousReply: string, message: string, flows: { name: string; description?: string }[]): Promise<Route | null> {
  const state = { previous_visitor_message: previousUser.slice(0, 600), previous_reply: previousReply.slice(0, 1200), message: message.slice(0, 800) };
  const questions: Record<string, JevQuestion> = {
    intent: { type: "choice", instructions: "A visitor writes to a business's website chat. What does the visitor's latest `message` want (read with the previous exchange)?", criteria: INTENTS },
    price: { type: "noul", instructions: "Does `message` ask what something costs (a price, a total, a quote)?" },
    specific: {
      type: "noul",
      instructions: "Does `message` (read with `previous_visitor_message` if it continues it) ask for one specific, concrete product or service, named precisely enough to ask a supplier for it - a specific kind, grade, model, size or parameter (e.g. 'waterproof concrete', 'facade scaffolding rental', 'an 18 m boom lift', '60x60 porcelain tiles')? Answer no for a broad category ('building materials', 'what do you have'), a question about this business itself, or small talk.",
    },
    followup: {
      type: "noul",
      instructions: "Is `message` a follow-up on `previous_reply`: asking for more details, prices or specifics of the businesses, products or offers that `previous_reply` names, or pushing back on it without naming anything new? Naming a specific product or kind of product that `previous_reply` does not name is NOT a follow-up.",
    },
    lang: { type: "choice", instructions: "In which language is `message` written?", criteria: { pl: "Polish", en: "English", uk: "Ukrainian", fr: "French", de: "German", other: "Any other language" } },
  };
  if (flows.length) {
    const criteria: Record<string, string> = { none: "None of these actions; or the visitor only asks a question, asks about a price, greets or chats." };
    flows.forEach((f, i) => { criteria[`flow_${i + 1}`] = `${f.name}: ${f.description || ""}`.slice(0, 400); });
    questions.flow = { type: "choice", instructions: "Does the visitor's `message` ask to START one of these actions of the business right now? Choose none if they only ask a question, ask about a price or information, greet or chat.", criteria };
  }
  const a = await jevAsk(state, questions, 5000);
  if (!a) return null;
  const ch = (k: string) => a[k] as JevChoiceAnswer | undefined;
  const nl = (k: string) => { const x = a[k] as JevNoulAnswer | undefined; return x && typeof x.noul === "number" ? x.noul : 0; };
  const it = ch("intent");
  if (!it?.choice) return null;
  let flow = -1, flowAmbiguous: number[] = [];
  const fl = ch("flow");
  if (fl?.choice && fl.probabilities) {
    const idx = (k: string) => (k.startsWith("flow_") ? parseInt(k.slice(5), 10) - 1 : -1);
    flow = idx(fl.choice);
    const top = fl.probabilities[fl.choice] ?? 0;
    flowAmbiguous = Object.entries(fl.probabilities).filter(([k, p]) => k !== "none" && p >= 0.3 && p >= top - 0.25).map(([k]) => idx(k)).filter((i) => i >= 0);
  }
  const lang = ch("lang")?.choice as OfferLang | undefined;
  return {
    intent: it.choice as Intent,
    flow, flowAmbiguous,
    price: nl("price"),
    specific: nl("specific"),
    followup: previousReply.trim() ? nl("followup") : 0,
    lang: lang && (OFFER_LANGS as readonly string[]).includes(lang) ? lang : "en",
    probabilities: it.probabilities || {},
  };
}
