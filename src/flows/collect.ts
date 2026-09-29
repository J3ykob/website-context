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

export type Llm = (system: string, user: string, maxTokens?: number) => Promise<string>;

export interface CollectSession {
  flowId: string;
  values: Record<string, string>;
  stage: "collecting" | "confirming";
  transcript: string[];
  language?: string; // as named by the model from the customer's messages
  at: number;
}

export interface Inquiry {
  flowId: string;
  flowName: string;
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

List the fields to collect as JSON: {"fields": [{"key": "snake_case_id", "label": "short label in the same language as the description", "required": true, "hint": "what belongs in it"}]}.
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
    fields.push({ name: key, label, type: "text", required: f?.required !== false, description: String(f?.hint || "").slice(0, 200) });
  }
  if (!fields.length) throw new Error("could not derive fields from the description");
  return fields;
}

export function startSession(flow: FlowDefinition): CollectSession {
  return { flowId: flow.id, values: {}, stage: "collecting", transcript: [], at: Date.now() };
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

/**
 * One customer message in an active session. Two model calls with separate
 * jobs: (1) read the message - which values it gives or corrects, and whether
 * it confirms / cancels; (2) write the reply about exactly what the code decided
 * (the missing fields, the summary, the thank-you), in the customer's language.
 * An existing value changes only on an explicit correction; a confirmation
 * never touches the values.
 */
export async function collectTurn(flow: FlowDefinition, s: CollectSession, message: string, brand: string, llm: Llm): Promise<CollectResult> {
  s.at = Date.now();
  const fields = fieldsOf(flow);
  const prior = s.transcript.slice(-12).join("\n");
  s.transcript.push(`Customer: ${message.slice(0, 1000)}`);

  const read = parseJsonObject(await llm(
    "You read one customer message in an order / inquiry chat and output only JSON.",
    `Fields (key | label | hint):
${fields.map((f) => `${f.name} | ${f.label} | ${f.description || ""}`).join("\n")}

Values collected so far: ${JSON.stringify(s.values)}
${s.stage === "confirming" ? "The customer was just shown a summary of these values and asked to confirm it." : ""}
Earlier conversation:
${prior || "(none)"}

The customer's new message: """${message.slice(0, 1000)}"""

Output {"language": "...", "intent": "...", "values": {...}}:
- "language": the language the new message is written in, in English (e.g. "Polish", "English", "Ukrainian").
- "intent": "confirm" (they confirm the summary / say it is correct), "cancel" (they want to stop the whole order or inquiry), "change" (they correct something already given), or "answer" (anything else: giving details, asking something).
- "values": ONLY the fields this new message gives or corrects, as {key: value}. Take values only from the customer's words; never invent or complete them. Keep their wording for products and quantities; give place names in their base form (e.g. "do Ząbek" -> "Ząbki") and keep street and number. A question the customer asks (price, availability...) goes into "notes". Empty object if the message gives no values.`,
    500,
  ));
  if (!read) throw new Error("collect: unparseable model reply");
  const intent = ["confirm", "cancel", "change", "answer"].includes(read.intent) ? read.intent : "answer";
  if (typeof read.language === "string" && read.language.trim()) s.language = read.language.trim().slice(0, 30);
  const language = s.language || "the same language as the customer's latest message";
  if (intent !== "confirm" && intent !== "cancel" && read.values && typeof read.values === "object") {
    for (const f of fields) {
      const v = typeof read.values[f.name] === "string" ? read.values[f.name].trim().slice(0, 500) : "";
      if (!v) continue;
      if (f.name === NOTES.name) s.values.notes = s.values.notes ? `${s.values.notes}; ${v}` : v;
      else if (!s.values[f.name] || intent === "change") s.values[f.name] = v;
    }
  }
  const missing = missingRequired(flow, s);

  // What the reply must do - decided here, not by the model.
  let task: string;
  let outcome: "cancel" | "send" | "summary" | "ask";
  if (intent === "cancel") { outcome = "cancel"; task = "Acknowledge in one short sentence that the order / inquiry is cancelled."; }
  else if (intent === "confirm" && s.stage === "confirming" && !missing.length) { outcome = "send"; task = `Thank them in one short sentence and say their ${flow.name ? `"${flow.name}" (say this name in ${language})` : "request"} is being passed to the team, who will get back to them.`; }
  else if (!missing.length) { outcome = "summary"; task = "In ONE sentence, ask them to check the summary and confirm it or correct anything. Do not list the details yourself."; }
  else { outcome = "ask"; task = `Ask, briefly, for exactly these details and nothing else: ${missing.slice(0, 2).map((f) => `${f.label}${f.description ? ` (${f.description})` : ""}`).join("; ")}.`; }
  const asked = (read.values?.notes || "").trim();
  if (asked && outcome !== "cancel") task += " They also asked something: do not answer it and promise nothing (no prices, availability or dates); say the team will reply to it together with the order.";

  // The reply as JSON: the message text, and (for the summary) the field names
  // translated into the customer's language.
  const shown = fields.filter((f) => (s.values[f.name] || "").trim());
  const out = parseJsonObject(await llm(
    `You are the chat assistant of ${brand || "this business"}. Write the assistant's next chat message: short, friendly, no lists. Write it in ${language}. Output only JSON.`,
    `Customer's latest message: """${message.slice(0, 600)}"""

Your task: ${task}

Output {"message": "the message text"${outcome === "summary" ? `, "labels": {${shown.map((f) => `"${f.name}": "${f.label} in ${language}"`).join(", ")}}` : ""}}.`,
    300,
  ));
  let reply = String(out?.message || "").trim().slice(0, 600);
  if (!reply) throw new Error("collect: empty reply");
  if (outcome === "cancel") return { reply, cancelled: true };
  if (outcome === "send") {
    s.transcript.push(`Assistant: ${reply}`);
    const inquiry: Inquiry = {
      flowId: flow.id,
      flowName: flow.name,
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
