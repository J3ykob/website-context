/**
 * The visitor's language for fixed texts, when the router's reading (Jev) is not
 * available: before routing (blocked input), in no-Jev mode, and in the server's
 * outage reply. Writing system first, then common words; English otherwise.
 * Only picks which of our fixed texts to show - never used for model prompts.
 */
import type { OfferLang } from "./jev.js";

const WORDS: [OfferLang, RegExp][] = [
  ["pl", /\b(czy|jak|ile|gdzie|jaki|jaka|jakie|macie|kiedy|dlaczego|kto|co|nie|tak|jest|się|chcę|proszę|dzień|dobry|anuluj|witam|cześć|dzięki)\b/],
  ["fr", /\b(je|vous|est|les|des|une|pour|avec|bonjour|merci|quel|quelle|combien|où|pourquoi|voudrais)\b/],
  ["de", /\b(ich|sie|ist|und|der|die|das|nicht|haben|wie|wo|warum|guten|danke|bitte|möchte)\b/],
  ["en", /\b(the|you|is|are|what|how|where|when|why|do|does|can|hello|thanks|please|i|my)\b/],
];

export function guessLang(text: string): OfferLang {
  const t = text.toLowerCase();
  if (/[Ѐ-ӿ]/.test(t)) return "uk";
  if (/[ąćęłńśźż]/.test(t)) return "pl";
  if (/[äöüß]/.test(t)) return "de";
  if (/[àâçèéêëîïôûùœ]/.test(t)) return "fr";
  let best: OfferLang = "en", hits = 0;
  for (const [l, re] of WORDS) {
    const n = (t.match(new RegExp(re.source, "g")) || []).length;
    if (n > hits) { best = l; hits = n; }
  }
  return best;
}

/** The server's reply when the chat backend fails (any cause), by the visitor's language. */
export const BACKEND_DOWN: Record<OfferLang, string> = {
  pl: "Przepraszam, mam teraz problem techniczny. Spróbuj proszę ponownie za chwilę.",
  en: "Sorry - I'm having trouble right now. Please try again in a moment.",
  uk: "Вибачте, зараз у мене технічна проблема. Спробуйте, будь ласка, ще раз за хвилину.",
  fr: "Désolé, je rencontre un problème technique. Réessayez dans un instant, s'il vous plaît.",
  de: "Entschuldigung, ich habe gerade ein technisches Problem. Bitte versuchen Sie es gleich noch einmal.",
  other: "Sorry - I'm having trouble right now. Please try again in a moment.",
};
