/**
 * "In chat" flows (executionMode "collect"): the assistant itself is the form.
 * The owner describes what to collect (e.g. an order: product, quantity,
 * delivery date and address, contact); the fields are derived from that once,
 * when the flow is created. In the conversation an LLM only extracts values
 * from what the customer wrote and phrases the next question; the code owns the
 * state: which required fields are missing, when to show the summary, and that
 * nothing is sent before the customer confirms it.
 */
import type { FlowDefinition, FlowInput } from "../context/types.js";
import { jevAsk } from "../llm/jev.js";

export type Llm = (system: string, user: string, maxTokens?: number) => Promise<string>;

/** When another business's bot started the inquiry (ecosystem referral). */
export interface CollectVia { tenantId: string; brand: string; sessionKey: string }

export interface CollectSession {
  flowId: string;
  via?: CollectVia;
  values: Record<string, string>;
  stage: "collecting" | "confirming";
  transcript: string[];
  language?: string; // as named by the model from the customer's messages
  // Offer check (fields of type "select"): what was already queried per field, so
  // a customer who insists on something we could not find is not asked again.
  offerChecked?: Record<string, string>;
  at: number;
}

export interface Inquiry {
  flowId: string;
  flowName: string;
  via?: CollectVia;
  fields: { label: string; value: string }[];
  transcript: string[];
  at: string;
}

export type CollectResult =
  | { reply: string }
  | { reply: string; cancelled: true }
  | { reply: string; inquiry: Inquiry };

// Free-form questions the customer asks along the way are kept here for the team.
const NOTES: FlowInput = { name: "notes", label: "Uwagi / pytania klienta", type: "text", required: false, description: "Anything else the customer wants the team to know or answer." };

/** First JSON object in an LLM reply (models sometimes wrap it in prose or fences). */
export function parseJsonObject(raw: string): any | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
}

/** Fields to collect, derived once from the owner's description (at flow creation). */
export async function deriveFields(description: string, llm: Llm): Promise<FlowInput[]> {
  const raw = await llm(
    "You design a short chat form for a business. Output only JSON.",
    `A business wants its website assistant to collect this from a customer in the chat and send it to the business:

"""${description.slice(0, 2000)}"""

List the fields to collect as JSON: {"fields": [{"key": "snake_case_id", "label": "short label (1-4 words) in the same language as the description", "required": true, "from_offer": false, "hint": "what belongs in it"}]}.
"from_offer" is true when the value must be something this business itself offers (its products, services, packages, locations), false for the customer's own details (quantities, dates, address, name, contact).
Rules: at most 10 fields; follow the description; always include the customer's name and one way to contact them (phone or email, required) unless the description says otherwise; do not add fields the description does not need.`,
    800,
  );
  const j = parseJsonObject(raw);
  const list: any[] = Array.isArray(j?.fields) ? j.fields : [];
  const seen = new Set<string>();
  const fields: FlowInput[] = [];
  for (const f of list.slice(0, 10)) {
    const key = String(f?.key || "").trim().slice(0, 40);
    const label = String(f?.label || "").trim().slice(0, 80);
    if (!key || !label || seen.has(key) || key === NOTES.name) continue;
    seen.add(key);
    // "select": checked against the business's own offer during the chat.
    fields.push({ name: key, label, type: f?.from_offer === true ? "select" : "text", required: f?.required !== false, description: String(f?.hint || "").slice(0, 200) });
  }
  if (!fields.length) throw new Error("could not derive fields from the description");
  return fields;
}

export function startSession(flow: FlowDefinition, via?: CollectVia): CollectSession {
  return { flowId: flow.id, values: {}, stage: "collecting", transcript: [], at: Date.now(), ...(via ? { via } : {}) };
}

/** Required fields still empty (labels) - for callers driving the session. */
export function missingLabels(flow: FlowDefinition, s: CollectSession): string[] {
  return missingRequired(flow, s).map((f) => f.label);
}

const fieldsOf = (flow: FlowDefinition) => [...flow.requiredInputs, NOTES];
const missingRequired = (flow: FlowDefinition, s: CollectSession) => flow.requiredInputs.filter((f) => f.required && !(s.values[f.name] || "").trim());

// The summary shown for confirmation: labels in the customer's language (given
// by the model), values exactly as recorded - the model never rewrites them.
function summary(flow: FlowDefinition, s: CollectSession, labels: Record<string, unknown> = {}): string {
  return fieldsOf(flow)
    .filter((f) => (s.values[f.name] || "").trim())
    .map((f) => `• ${typeof labels[f.name] === "string" && (labels[f.name] as string).trim() ? (labels[f.name] as string).trim() : f.label}: ${s.values[f.name]}`)
    .join("\n");
}

// Writing systems other than Latin, by Unicode block. The answer model sometimes
// slips a Cyrillic or CJK word into a Polish reply ("Uтоżsамnij").
const SCRIPTS: [string, number, number][] = [
  ["Cyrillic", 0x0400, 0x04ff], ["Greek", 0x0370, 0x03ff], ["Hebrew", 0x0590, 0x05ff], ["Arabic", 0x0600, 0x06ff],
  ["Thai", 0x0e00, 0x0e7f], ["Kana", 0x3040, 0x30ff], ["CJK", 0x4e00, 0x9fff], ["Hangul", 0xac00, 0xd7af],
];
function scriptsIn(text: string): Set<string> {
  const found = new Set<string>();
  for (const ch of text) {
    const c = ch.codePointAt(0) || 0;
    for (const [name, lo, hi] of SCRIPTS) if (c >= lo && c <= hi) found.add(name);
  }
  return found;
}
/** Scripts in the reply that the customer's own message does not use. */
export function strayScripts(customer: string, reply: string): string[] {
  const own = scriptsIn(customer);
  return [...scriptsIn(reply)].filter((x) => !own.has(x));
}

type OfferVerdict = { status: "ok" } | { status: "several" | "not_offered"; options: string[]; missing: string[] } | { status: "not_seen"; missing: string[] };

/**
 * Is what the customer asked for in this business's offer? The same rule as
 * choices on a page: one clear match -> take it; several possible -> ask which;
 * not offered -> say so and suggest what is. Judged from the business's own
 * knowledge; when that knowledge says nothing about it (e.g. a catalog behind a
 * login), the customer's words are accepted as they are. Suggested names must
 * appear in the knowledge text itself, so nothing is invented.
 */
async function checkOffer(value: string, field: FlowInput, knowledge: (q: string) => string[], llm: Llm): Promise<OfferVerdict> {
  const passages = knowledge(value).slice(0, 5);
  if (!passages.length) return { status: "ok" };
  // Whether it is offered is a classification: Jev (stable across runs; the
  // answer model flip-flopped). Acted on only when clear; otherwise accepted.
  const a = await jevAsk({ business_information: passages, customer_request: value }, { status: { type: "choice", instructions: "Judging only by `business_information` (excerpts from this business's own website), is what the customer asks for in `customer_request` part of the business's offer?", criteria: {
    offered: "Yes: the excerpts show the business offers exactly this, or clearly this.",
    several: "The excerpts show several different offers that could be what the customer means, and it is unclear which one.",
    not_offered: "No: the excerpts show what the business offers in this area, and what was asked is not among it (a different kind of product or service).",
    unknown: "The excerpts do not say whether the business offers this.",
  } } }, 6000);
  const probs = ((a?.status as any)?.probabilities || {}) as Record<string, number>;
  const status = (probs.not_offered ?? 0) >= 0.6 ? "not_offered" : (probs.several ?? 0) >= 0.5 ? "several" : a ? "ok" : "fallback";
  if (status === "ok") return { status: "ok" };
  // The concrete alternatives (or, without Jev, the whole judgment) by the model.
  const j = parseJsonObject(await llm(
    "You check a customer's request against a business's own information and output only JSON.",
    `The business's own information (excerpts from its website):
${passages.map((p, k) => `[${k + 1}] ${p}`).join("\n")}

The customer asked for (${field.label}): """${value}"""
${status === "fallback" ? "" : `It was judged: ${status === "several" ? "several different offers could be what they mean" : "not part of the offer"}.`}

Output {"status": "...", "missing": [...], "options": [...]}:
- "status": "offered" if the excerpts show the business offers what was asked; "several" if the excerpts list several different offers and it is unclear which one the customer means; "not_offered" if the excerpts list what the business offers in this area and (some of) what was asked is not among it; "unknown" if the excerpts do not say.
- "missing": for "not_offered", the requested items that are not in the offer.
- "options": for "several" or "not_offered", up to 5 concrete offers from the excerpts that serve the SAME need (the same kind of product or service the customer wants) - names of specific products, product lines, services or packages, each written exactly as in the excerpts. Something that only shares a word with the request (e.g. tiles in a "cement" style for someone who wants cement) is not the same need. Empty if nothing serves that need.`,
    400,
  ));
  const verdict = status === "fallback" ? j?.status : status;
  if (verdict !== "several" && verdict !== "not_offered") return { status: "ok" };
  const text = passages.join("\n").toLowerCase();
  const options = (Array.isArray(j?.options) ? j.options : [])
    .filter((o: unknown): o is string => typeof o === "string" && o.trim().length > 1 && text.includes(o.trim().toLowerCase()))
    .map((o: string) => o.trim().slice(0, 120))
    .slice(0, 5);
  const missing = (Array.isArray(j?.missing) ? j.missing : []).filter((m: unknown): m is string => typeof m === "string").slice(0, 5);
  if (!options.length) {
    // Nothing to offer instead. "several" without names is just unclear: accept.
    // "not offered": keep their words (the team confirms), but say so honestly.
    return verdict === "not_offered" ? { status: "not_seen", missing } : { status: "ok" };
  }
  return { status: verdict, options, missing };
}

/**
 * One customer message in an active session. Two model calls with separate
 * jobs: (1) read the message - which values it gives or corrects, and whether
 * it confirms / cancels; (2) write the reply about exactly what the code decided
 * (the missing fields, the summary, the thank-you), in the customer's language.
 * An existing value changes only on an explicit correction; a confirmation
 * never touches the values.
 */
export async function collectTurn(flow: FlowDefinition, s: CollectSession, message: string, brand: string, llm: Llm, knowledge?: (q: string) => string[]): Promise<CollectResult> {
  s.at = Date.now();
  const fields = fieldsOf(flow);
  const prior = s.transcript.slice(-12).join("\n");
  s.transcript.push(`Customer: ${message.slice(0, 1000)}`);

  const read = parseJsonObject(await llm(
    `You read one customer message in an order / inquiry chat for the business ${brand || "(this business)"} and output only JSON.`,
    `Fields (key | label | hint):
${fields.map((f) => `${f.name} | ${f.label} | ${f.description || ""}`).join("\n")}

Values collected so far: ${JSON.stringify(s.values)}
${s.stage === "confirming" ? "The customer was just shown a summary of these values and asked to confirm it." : ""}
Earlier conversation:
${prior || "(none)"}

The customer's new message: """${message.slice(0, 1000)}"""

Output {"language": "...", "switched": false, "intent": "...", "values": {...}}:
- "language": the language the customer writes their sentences in, named in English (e.g. "Polish", "English", "Ukrainian"). Ignore names of places, streets, people and products (a Polish street name in an English sentence is still English).${s.language ? `
- "switched": true only if in this message the customer clearly writes whole sentences in a language other than ${s.language}, the language of the conversation so far; otherwise false.` : ""}
- "intent": "confirm" (they confirm the summary / say it is correct), "cancel" (they want to stop the whole order or inquiry), "change" (they correct something already given), or "answer" (anything else: giving details, asking something).
- "values": ONLY the fields this new message gives or corrects, as {key: value}. The business's own name, brand or town (${brand || "this business"}) says who receives the order - it is never a value of the customer's (in "I want to order from ${brand || "X"}" it is not a place or a name). Take values only from the customer's words; never invent or complete them. Keep their wording for products and quantities; give place names in their dictionary (nominative) form, not the case ending used in the sentence (e.g. "do Ząbek" -> "Ząbki"), and keep street and number. A question the customer asks (price, availability...) goes into "notes". Empty object if the message gives no values.`,
    500,
  ));
  if (!read) throw new Error("collect: unparseable model reply");
  const intent = ["confirm", "cancel", "change", "answer"].includes(read.intent) ? read.intent : "answer";
  // The conversation's language is set by the first message and changes only
  // when the customer clearly switches (a Polish address in an English message
  // is not a switch).
  if (typeof read.language === "string" && read.language.trim() && (!s.language || read.switched === true)) s.language = read.language.trim().slice(0, 30);
  const language = s.language || "the same language as the customer's latest message";
  if (intent !== "confirm" && intent !== "cancel" && read.values && typeof read.values === "object") {
    for (const f of fields) {
      const v = typeof read.values[f.name] === "string" ? read.values[f.name].trim().slice(0, 500) : "";
      if (!v) continue;
      if (f.name === NOTES.name) s.values.notes = s.values.notes ? `${s.values.notes}; ${v}` : v;
      // A value the new message states directly replaces the earlier one (an
      // address given after a wrongly inferred one); a confirmation changes nothing.
      else s.values[f.name] = v;
    }
  }
  // Offer fields just given (or corrected): check them against the offer.
  let offerAsk = "";  // needs the customer's choice before going on
  let offerNote = ""; // just said along with the next question
  if (knowledge && intent !== "confirm" && intent !== "cancel") {
    s.offerChecked = s.offerChecked || {};
    for (const f of flow.requiredInputs.filter((x) => x.type === "select")) {
      const v = s.values[f.name];
      if (!v || s.offerChecked[f.name] === v) continue;
      s.offerChecked[f.name] = v;
      // We already suggested alternatives for this field once: take their answer.
      if (s.offerChecked[`${f.name}:suggested`] === "1") { s.offerChecked[`${f.name}:suggested`] = ""; continue; }
      const verdict = await checkOffer(v, f, knowledge, llm).catch(() => ({ status: "ok" }) as OfferVerdict);
      if (verdict.status === "ok") continue;
      if (verdict.status === "not_seen") {
        offerNote = `Say briefly that you can't see ${verdict.missing.length ? verdict.missing.join(", ") : v} in the offer, so the team will confirm whether they can provide it.`;
        continue;
      }
      // Their words stay recorded: we ask once, and if they go on without
      // choosing, the order goes out with what they wrote (they confirm it in
      // the summary) instead of asking the same question again and again.
      s.offerChecked[`${f.name}:suggested`] = "1";
      offerAsk = verdict.status === "several"
        ? `What they asked for (${v}) could be several different offers: ${verdict.options.join("; ")}. Ask which one they mean (they may also leave it to the team).`
        : `Say that you can't see ${verdict.missing.length ? verdict.missing.join(", ") : v} in the offer, and suggest what is available, e.g.: ${verdict.options.join("; ")}. Ask whether one of these suits them, or what else they need.`;
      break;
    }
  }
  const missing = missingRequired(flow, s);

  // What the reply must do - decided here, not by the model.
  let task: string;
  let outcome: "cancel" | "send" | "summary" | "ask";
  if (intent === "cancel") { outcome = "cancel"; task = "Acknowledge in one short sentence that the order / inquiry is cancelled."; }
  else if (intent === "confirm" && s.stage === "confirming" && !missing.length) { outcome = "send"; task = `Thank them in one short sentence and say their order / request is being passed to the team, who will get back to them.`; }
  else if (offerAsk) { outcome = "ask"; task = offerAsk; }
  else if (!missing.length) { outcome = "summary"; task = "In ONE sentence, ask them to check the summary and confirm it or correct anything. Do not list the details yourself."; }
  else { outcome = "ask"; task = `Ask, briefly, for exactly these details and nothing else: ${missing.slice(0, 2).map((f) => `${f.label}${f.description ? ` (${f.description})` : ""}`).join("; ")}.`; }
  if (offerNote && outcome !== "cancel" && outcome !== "send") task = `${offerNote} Then: ${task}`;
  const asked = (read.values?.notes || "").trim();
  if (asked && outcome !== "cancel") task += " They also asked something: do not answer it and promise nothing (no prices, availability or dates); say the team will reply to it together with the order.";

  // The reply as JSON: the message text, and (for the summary) the field names
  // translated into the customer's language.
  const shown = fields.filter((f) => (s.values[f.name] || "").trim());
  const replySystem = `You are the chat assistant of ${brand || "this business"}. Write the assistant's next chat message: short, friendly, no lists. Write it in ${language}; the field names in the task may be in another language - translate them into ${language}. Output only JSON.`;
  const replyUser = `Customer's latest message: """${message.slice(0, 600)}"""

Your task: ${task}

Output {"message": "the message text"${outcome === "summary" ? `, "labels": {${shown.map((f) => `"${f.name}": "<'${f.label}' translated into ${language}>"`).join(", ")}}` : ""}}.${outcome === "summary" ? ` "labels" holds each field name translated into ${language} (the summary is shown to the customer).` : ""}`;
  let out = parseJsonObject(await llm(replySystem, replyUser, 300));
  const stray = strayScripts(message, String(out?.message || ""));
  if (stray.length) {
    const again = parseJsonObject(await llm(`${replySystem} Use only the normal alphabet of ${language}; never mix in ${stray.join(" or ")} letters.`, replyUser, 300));
    if (again?.message && strayScripts(message, String(again.message)).length === 0) out = again;
  }
  // The model sometimes slips into the language of the field names or of a place
  // name in the message. Jev checks the reply is in the customer's language.
  if (s.language && out?.message) {
    const inLang = async (t: string) => (await jevAsk({ text: t }, { ok: { type: "noul", instructions: `Is \`text\` written in ${s.language}?` } }, 3000))?.ok as { noul?: number } | undefined;
    const v = await inLang(String(out.message));
    if (v && (v.noul ?? 1) < 0.5) {
      const again = parseJsonObject(await llm(`${replySystem} Your previous draft was not in ${s.language}. Write the message ONLY in ${s.language}.`, replyUser, 300));
      if (again?.message) out = again;
    }
  }
  let reply = String(out?.message || "").trim().slice(0, 600);
  if (!reply) throw new Error("collect: empty reply");
  if (outcome === "cancel") return { reply, cancelled: true };
  if (outcome === "send") {
    s.transcript.push(`Assistant: ${reply}`);
    const inquiry: Inquiry = {
      flowId: flow.id,
      flowName: flow.name,
      ...(s.via ? { via: s.via } : {}),
      fields: fields.filter((f) => (s.values[f.name] || "").trim()).map((f) => ({ label: f.label, value: s.values[f.name] })),
      transcript: s.transcript.slice(-30),
      at: new Date().toISOString(),
    };
    return { reply, inquiry };
  }
  if (outcome === "summary") { s.stage = "confirming"; reply = `${reply}\n\n${summary(flow, s, out?.labels && typeof out.labels === "object" ? out.labels : {})}`; }
  else s.stage = "collecting";
  s.transcript.push(`Assistant: ${reply}`);
  return { reply };
}
