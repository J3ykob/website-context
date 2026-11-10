/**
 * The knowledge audit's own constants (no imports, so the low-level stores can use them without pulling in the
 * audit's LLM / Jev chain): the fixed test questions, the data-check topics and the panel's hint keys.
 */

export const AUDIT_QUESTIONS: readonly { topic: string; pl: string; en: string }[] = [
  { topic: "contact", pl: "Jak mogę się z wami skontaktować - jaki jest numer telefonu i e-mail?", en: "How can I contact you - what is your phone number and e-mail?" },
  { topic: "hours", pl: "W jakich godzinach jesteście dostępni? Kiedy można do was dzwonić?", en: "What are your opening hours? When can I call you?" },
  { topic: "area", pl: "Na jakim terenie działacie? Dojeżdżacie poza miasto?", en: "Which area do you serve? Do you travel outside the city?" },
  { topic: "prices", pl: "Ile kosztują wasze usługi? Macie cennik?", en: "How much do your services cost? Do you have a price list?" },
  { topic: "quote", pl: "Czy wycena jest bezpłatna? Jak wygląda wycena?", en: "Is a quote free? How does a quote work?" },
  { topic: "payment", pl: "Jakie formy płatności akceptujecie? Czy trzeba wpłacić zaliczkę?", en: "Which payment methods do you accept? Is a deposit needed?" },
  { topic: "warranty", pl: "Czy dajecie gwarancję na swoje usługi? Na jak długo?", en: "Do you give a warranty on your work? For how long?" },
  { topic: "lead_time", pl: "Jak szybko możecie zacząć i ile zwykle trwa realizacja?", en: "How soon can you start and how long does a job usually take?" },
];

/** The data checks' topics (dataChecks in audit.ts). */
export const AUDIT_DATA_TOPICS = ["pages", "garbled", "phone", "email", "address", "hours"] as const;

/** Every wording of the test questions. Rows the audit logged as unanswered questions before 2026-11-10 carry
 * exactly one of these; the gaps list and its counts leave them out (exact match on our own text only). */
export const SELF_TEST_QUESTIONS: readonly string[] = AUDIT_QUESTIONS.flatMap((q) => [q.pl, q.en]);

/** Every "<kind>.<topic>" an audit item can have - the panel's hint keys. */
export const AUDIT_HINT_KEYS: readonly string[] = [
  ...AUDIT_DATA_TOPICS.map((t) => `data.${t}`),
  ...AUDIT_QUESTIONS.map((q) => `question.${q.topic}`),
];
