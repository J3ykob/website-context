import type { FlowDefinition, FlowInput, FlowStep } from "../context/types.js";
import { executeFlow, type ExecutionResult, type ExecutionOptions } from "./executor.js";
import { ClaudeCLIProvider } from "../llm/claude-cli-provider.js";

// --- Flow Input Sanitization ---

const INPUT_MAX_LENGTHS: Record<string, number> = {
  text: 500,
  email: 100,
  phone: 100,
  number: 50,
  select: 200,
  date: 50,
};

const SQL_INJECTION_PATTERNS = [
  /('\s*(or|and)\s*'?\d*\s*=\s*\d*)/i,
  /(;\s*(drop|alter|delete|insert|update)\s)/i,
  /(union\s+(all\s+)?select)/i,
  /(--.*)$/i,
  /(\/\*[\s\S]*?\*\/)/,
];

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface SanitizeResult {
  value: string;
  valid: boolean;
  error?: string;
}

function sanitizeFlowInput(value: string, input: FlowInput): SanitizeResult {
  let sanitized = value;

  // Strip HTML tags
  sanitized = sanitized.replace(/<[^>]*>/g, "");

  // Strip script content specifically
  sanitized = sanitized.replace(/<script[\s\S]*?<\/script>/gi, "");

  // Check for SQL injection patterns
  for (const pattern of SQL_INJECTION_PATTERNS) {
    if (pattern.test(sanitized)) {
      return { value: "", valid: false, error: `Invalid input for ${input.label}: contains disallowed characters` };
    }
  }

  // Length limit based on type
  const maxLen = INPUT_MAX_LENGTHS[input.type] || 500;
  if (sanitized.length > maxLen) {
    sanitized = sanitized.slice(0, maxLen);
  }

  // Type-specific validation
  if (input.type === "email") {
    if (!EMAIL_REGEX.test(sanitized)) {
      return { value: sanitized, valid: false, error: `"${sanitized}" doesn't look like a valid email address` };
    }
  }

  if (input.type === "phone") {
    // Allow only digits, spaces, dashes, plus, parens
    if (!/^[\d\s\-+()]+$/.test(sanitized)) {
      return { value: sanitized, valid: false, error: `"${sanitized}" doesn't look like a valid phone number` };
    }
  }

  if (input.type === "number") {
    if (!/^-?\d+(\.\d+)?$/.test(sanitized.trim())) {
      return { value: sanitized, valid: false, error: `"${sanitized}" is not a valid number` };
    }
  }

  return { value: sanitized, valid: true };
}

export interface FlowSession {
  flowId: string;
  flow: FlowDefinition;
  collectedInputs: Record<string, string>;
  remainingInputs: FlowInput[];
  status: "collecting" | "confirming" | "choosing" | "touring" | "executing" | "done" | "failed";
  result?: ExecutionResult;
  executionMode?: "background" | "guided" | "highlight";
  // Step ids already sent to the widget for live (incremental) execution.
  executedStepIds?: string[];
  executedInputNames?: string[];
  // Highlight tour: which field the visitor is currently on.
  tourIndex?: number;
}

// A form field derived from the recording — the unit the LLM operates on. The
// flow is described as its fields; the bot chooses set/highlight/get per field.
export interface FlowField {
  name: string;
  label: string;
  type: string;
  required: boolean;
  target: Record<string, string>;
}

// One operation the widget performs on the real form. "set" fills it, "highlight"
// points at it for the visitor, "submit" waits for the final click.
export interface FormAction {
  op: "set" | "highlight" | "submit";
  name?: string;
  label?: string;
  value?: string;
  fieldType?: string;
  instruction?: string;
  target?: Record<string, string>;
}

export interface ConversationResponse {
  message: string;
  session: FlowSession;
  // Steps the widget should execute RIGHT NOW (incremental live execution —
  // each collected input lands on the page immediately).
  liveSteps?: FlowStep[];
  // Field operations for the widget's form controller (v2 execution model).
  formActions?: FormAction[];
  /** When true, the flow has finished executing (success or failure) */
  complete: boolean;
}

/**
 * Starts a new flow session and returns the first question to ask the user.
 */
function sortedSteps(flow: FlowDefinition): FlowStep[] {
  return [...flow.steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
function stepsBoundToInputs(flow: FlowDefinition, names: string[]): FlowStep[] {
  if (names.length === 0) return [];
  return sortedSteps(flow).filter((st) => typeof st.value === "string" && names.some((n) => (st.value as string).includes(`{{${n}}}`)));
}
function leadingSetupSteps(flow: FlowDefinition): FlowStep[] {
  const out: FlowStep[] = [];
  for (const st of sortedSteps(flow)) {
    if (typeof st.value === "string" && /\{\{.+?\}\}/.test(st.value)) break;
    out.push(st);
  }
  return out;
}
function unexecutedSteps(session: FlowSession): FlowStep[] {
  const done = new Set(session.executedStepIds || []);
  return sortedSteps(session.flow).filter((st) => !done.has(st.id));
}
function markExecuted(session: FlowSession, steps: FlowStep[]): void {
  if (steps.length === 0) return;
  session.executedStepIds = [...(session.executedStepIds || []), ...steps.map((st) => st.id)];
}

// Derive the ordered field registry from the recording: each required input
// mapped to the recorded step that fills it (selector + type).
export function flowFields(flow: FlowDefinition): FlowField[] {
  const steps = sortedSteps(flow);
  return flow.requiredInputs.map((inp) => {
    const st = steps.find((s2) => typeof s2.value === "string" && (s2.value as string).includes(`{{${inp.name}}}`));
    return {
      name: inp.name,
      label: inp.label,
      type: inp.type || (st && st.action === "select" ? "select" : "text"),
      required: inp.required !== false,
      target: (st && (st.target as Record<string, string>)) || {},
    };
  });
}
function submitAction(flow: FlowDefinition): FormAction | null {
  const submit = sortedSteps(flow).find((s2) => s2.action === "click");
  if (!submit) return null;
  return { op: "submit", target: submit.target as Record<string, string>, instruction: "Click to finish" };
}
function setActionFor(session: FlowSession, name: string): FormAction | null {
  const field = flowFields(session.flow).find((f) => f.name === name);
  if (!field || !session.collectedInputs[name]) return null;
  return { op: "set", name, label: field.label, value: session.collectedInputs[name], fieldType: field.type, target: field.target };
}

export function startFlowSession(flow: FlowDefinition): ConversationResponse {
  const session: FlowSession = {
    flowId: flow.id,
    flow,
    collectedInputs: {},
    remainingInputs: [...flow.requiredInputs],
    status: "collecting",
  };

  // Mode question comes FIRST — from then on every collected input lands on the
  // page immediately (live incremental execution), so the visitor must pick
  // auto-fill vs highlight before collection starts.
  session.status = "choosing";
  return {
    message: `Sure — I can help with "${flow.name}". Should I fill things in for you as we go, or show you where everything goes so you do it yourself?`,
    session,
    complete: false,
  };
}

/**
 * Processes the user's message within a flow session.
 * Extracts input values, advances to the next question or confirmation, and executes when confirmed.
 */
export async function processUserInput(
  session: FlowSession,
  userMessage: string,
  // Injectable LLM call — the multi-tenant server passes an OpenRouter-backed
  // generate; the Claude CLI default only works on a dev machine (on prod it
  // threw and the fallback treated the WHOLE message as one field's value).
  generate?: (system: string, prompt: string) => Promise<string>,
  // Live form state (field name -> current on-page value), sent by the widget
  // on every turn so the bot always knows what is already filled.
  formState?: Record<string, string>
): Promise<ConversationResponse> {
  const msg = userMessage.trim();

  if (session.status === "confirming") {
    return handleConfirmation(session, msg);
  }

  if (session.status === "choosing") {
    return handleModeChoice(session, msg, generate);
  }

  if (session.status === "touring") {
    return handleTour(session, msg, formState || {}, generate);
  }

  if (session.status === "collecting") {
    return handleInputCollection(session, msg, generate);
  }

  // If already done or failed, just return state
  return {
    message: session.status === "done"
      ? "This flow has already completed."
      : "This flow encountered an error. Please start over.",
    session,
    complete: true,
  };
}

async function handleInputCollection(
  session: FlowSession,
  userMessage: string,
  generate?: (system: string, prompt: string) => Promise<string>
): Promise<ConversationResponse> {
  // Escape hatch — a collection session must never trap the visitor (any
  // message used to be force-parsed as the next field value, with no way out).
  const lower = userMessage.toLowerCase().trim();
  const cancelWords = ["cancel", "stop", "quit", "exit", "nevermind", "never mind", "forget it", "anuluj", "przerwij", "rezygnuje", "rezygnuję", "nie chce", "nie chcę"];
  if (cancelWords.some((w) => lower === w || lower.startsWith(w + " ") || lower.endsWith(" " + w))) {
    session.status = "failed";
    return {
      message: "No problem — I've cancelled that. What else can I help you with?",
      session,
      complete: true,
    };
  }

  // Use LLM to extract all possible values from the user's message
  const allNeeded = session.flow.requiredInputs;
  const remaining = session.remainingInputs;

  const llmGenerate = generate || (async (system: string, prompt: string) => {
    const cli = new ClaudeCLIProvider({ mode: "local", model: "haiku" });
    return cli.generate(system, prompt);
  });

  const inputSpec = remaining.map((i) => `- "${i.name}" (${i.type}): ${i.label} — ${i.description || ""}`).join("\n");

  const parsePrompt = `Extract values for these fields from the user's message. Return ONLY a JSON object with field names as keys and extracted values as strings. If a field's value is not found in the message, omit it from the JSON. Do not invent values.

Fields to extract:
${inputSpec}

User's message: "${userMessage}"

Return only valid JSON, nothing else.`;

  try {
    const response = await llmGenerate("You are a JSON extractor. Output only valid JSON.", parsePrompt);
    let jsonStr = response.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const extracted = JSON.parse(jsonStr) as Record<string, string>;

    const collectedBefore = Object.keys(session.collectedInputs).length;
    const newlyCollected: string[] = [];
    const sanitizationErrors: string[] = [];
    for (const [name, value] of Object.entries(extracted)) {
      if (value && remaining.some((i) => i.name === name)) {
        const inputDef = remaining.find((i) => i.name === name)!;
        const result = sanitizeFlowInput(String(value), inputDef);
        if (result.valid) {
          session.collectedInputs[name] = result.value;
          session.remainingInputs = session.remainingInputs.filter((i) => i.name !== name);
          newlyCollected.push(name);
        } else {
          sanitizationErrors.push(result.error || `Invalid value for ${inputDef.label}`);
        }
      }
    }

    if (sanitizationErrors.length > 0) {
      return {
        message: sanitizationErrors.join("\n") + "\n\nCould you please provide valid values? (You can also say \"cancel\" to stop.)",
        session,
        complete: false,
      };
    }

    // Nothing extracted — maybe the visitor is stating HOW they want it done
    // mid-collection. Classify and record; the mode question is then skipped.
    if (Object.keys(session.collectedInputs).length === collectedBefore) {
      const midIntent = await classifyModeChoice(userMessage, generate);
      const midChoice = midIntent === "guided" || midIntent === "highlight" ? midIntent : null;
      if (midChoice) {
        session.executionMode = midChoice;
        const stillReq = session.remainingInputs.filter((i) => i.required !== false).map((i) => i.label).join(", ");
        return {
          message: (midChoice === "highlight"
            ? "Got it — I'll show you where everything goes once we have the details."
            : "Got it — I'll fill it in for you once we have the details.")
            + (stillReq ? ` I still need: ${stillReq}.` : ""),
          session,
          complete: false,
        };
      }
    }
  } catch {
    // LLM parse failed — check for a mode statement before force-parsing the
    // message as a field value.
    const fbIntent = await classifyModeChoice(userMessage, generate);
    const fallbackChoice = fbIntent === "guided" || fbIntent === "highlight" ? fbIntent : null;
    if (fallbackChoice) {
      session.executionMode = fallbackChoice;
      const stillReq = session.remainingInputs.filter((i) => i.required !== false).map((i) => i.label).join(", ");
      return {
        message: (fallbackChoice === "highlight"
          ? "Got it — I'll show you where everything goes once we have the details."
          : "Got it — I'll fill it in for you once we have the details.")
          + (stillReq ? ` I still need: ${stillReq}.` : ""),
        session,
        complete: false,
      };
    }
    if (remaining.length > 0) {
      const current = remaining[0];
      const result = sanitizeFlowInput(userMessage.trim(), current);
      if (result.valid) {
        session.collectedInputs[current.name] = result.value;
        session.remainingInputs = session.remainingInputs.filter((i) => i.name !== current.name);
      } else {
        return {
          message: (result.error || `That doesn't look right. Could you try again?`) + ` (Or say "cancel" to stop.)`,
          session,
          complete: false,
        };
      }
    }
  }

  // GUIDED (auto) mode: each just-collected input is filled on the page NOW via
  // a "set" form action (date/select coercion happens in the widget controller).
  const newlyCollectedAll = Object.keys(session.collectedInputs).filter(
    (n) => !(session.executedInputNames || (session.executedInputNames = [])).includes(n)
  );
  const liveSets: FormAction[] = newlyCollectedAll.map((n) => setActionFor(session, n)).filter((a): a is FormAction => !!a);
  session.executedInputNames = [...(session.executedInputNames || []), ...newlyCollectedAll];

  // Only REQUIRED inputs gate completion — optionals are captured if volunteered.
  const stillRequired = session.remainingInputs.filter((i) => i.required !== false);
  if (stillRequired.length > 0) {
    const still = stillRequired.map((i) => i.label).join(", ");
    return {
      message: `I still need: ${still}. Could you provide ${stillRequired.length === 1 ? "it" : "them"}?`,
      session,
      complete: false,
      formActions: liveSets.length ? liveSets : undefined,
    };
  }
  session.remainingInputs = [];

  const summary = Object.entries(session.collectedInputs)
    .map(([key, val]) => {
      const input = allNeeded.find((i) => i.name === key);
      return `- ${input?.label || key}: ${val}`;
    })
    .join("\n");

  session.status = "executing";
  const submit = submitAction(session.flow);
  return {
    message: `Got it!\n${summary}\n\nFilling it in on the page${submit ? " — just click the highlighted button to confirm" : ""}.`,
    session,
    complete: false,
    formActions: submit ? [...liveSets, submit] : liveSets,
  };
}

// ─── Highlight tour: one field at a time, chat-driven ────────────────────────
function tourFields(session: FlowSession): FlowField[] {
  return flowFields(session.flow).filter((f) => f.required);
}
function highlightAction(field: FlowField, instruction: string): FormAction {
  return { op: "highlight", name: field.name, label: field.label, fieldType: field.type, target: field.target, instruction };
}
function fieldInstruction(field: FlowField): string {
  if (field.type === "select") return `Choose ${field.label.toLowerCase()} here`;
  if (field.type === "date") return `Pick ${field.label.toLowerCase()} here`;
  return `Type your ${field.label.toLowerCase()} here`;
}

function startTour(session: FlowSession): ConversationResponse {
  session.status = "touring";
  session.tourIndex = 0;
  const fields = tourFields(session);
  if (fields.length === 0) {
    session.status = "executing";
    const submit = submitAction(session.flow);
    return { message: "Everything's ready — just click the highlighted button to finish.", session, complete: false, formActions: submit ? [submit] : [] };
  }
  const f = fields[0];
  return {
    message: `Let's do it together. ${f.label} first — I've highlighted the field on the page. Fill it in, then tell me "done" and I'll point you to the next one.`,
    session,
    complete: false,
    formActions: [highlightAction(f, fieldInstruction(f))],
  };
}

// Classify what the visitor wants mid-tour, using the LLM (no keyword lists).
async function classifyTourIntent(
  message: string,
  fieldLabel: string,
  generate?: (system: string, prompt: string) => Promise<string>
): Promise<"next" | "back" | "cancel" | "fill" | "other"> {
  if (!generate) return "next";
  const prompt = `A visitor is filling a web form one field at a time. The current field is "${fieldLabel}". They just said: "${message}"

Classify their intent into exactly one word:
- "next"   = they finished this field / want to move on (done, ok, next, ready, filled it)
- "back"   = they want to go back to the previous field / change something earlier
- "cancel" = they want to stop / abandon the form
- "fill"   = they are giving YOU a value to put in for them instead of typing it themselves
- "other"  = a question or anything else

Respond with ONLY the single word.`;
  try {
    const raw = (await generate("You classify intent. One word only.", prompt)).toLowerCase();
    for (const k of ["cancel", "back", "fill", "next", "other"] as const) if (new RegExp(`\\b${k}\\b`).test(raw)) return k;
    return "next";
  } catch { return "next"; }
}

async function handleTour(
  session: FlowSession,
  userMessage: string,
  formState: Record<string, string>,
  generate?: (system: string, prompt: string) => Promise<string>
): Promise<ConversationResponse> {
  const fields = tourFields(session);
  let idx = session.tourIndex ?? 0;
  const current = fields[idx];
  const intent = await classifyTourIntent(userMessage, current ? current.label : "", generate);

  if (intent === "cancel") {
    session.status = "failed";
    return { message: "No problem — I've stopped. Anything else I can help with?", session, complete: true };
  }

  if (intent === "fill") {
    // Visitor asked the bot to fill this field — extract a value and set it.
    const val = userMessage.replace(/^[^:]*:/, "").trim() || userMessage.trim();
    const clean = sanitizeFlowInput(val, session.flow.requiredInputs.find((i) => i.name === current.name) || { name: current.name, label: current.label, type: current.type as any, required: true, description: "" });
    if (clean.valid) {
      session.collectedInputs[current.name] = clean.value;
      return {
        message: `Done — I filled in ${current.label} for you. Say "next" when you're ready to continue.`,
        session,
        complete: false,
        formActions: [{ op: "set", name: current.name, label: current.label, value: clean.value, fieldType: current.type, target: current.target }],
      };
    }
  }

  if (intent === "back") {
    idx = Math.max(0, idx - 1);
    session.tourIndex = idx;
    const f = fields[idx];
    return {
      message: `Sure — back to ${f.label}. I've highlighted it again.`,
      session,
      complete: false,
      formActions: [highlightAction(f, fieldInstruction(f))],
    };
  }

  // intent "next"/"other": advance if the current field looks filled on the page.
  const filled = current ? (formState[current.name] || "").trim().length > 0 : true;
  if (current && !filled && intent !== "other") {
    return {
      message: `I don't see ${current.label} filled in yet — go ahead and complete it on the page, then tell me "done". (Or say "skip" and I'll fill it for you.)`,
      session,
      complete: false,
      formActions: [highlightAction(current, fieldInstruction(current))],
    };
  }

  idx += 1;
  session.tourIndex = idx;
  if (idx < fields.length) {
    const f = fields[idx];
    const ack = current ? `Great, ${current.label} is set. ` : "";
    return {
      message: `${ack}Next: ${f.label}. I've highlighted it — fill it in and say "done".`,
      session,
      complete: false,
      formActions: [highlightAction(f, fieldInstruction(f))],
    };
  }

  // All fields done — highlight submit.
  session.status = "executing";
  const submit = submitAction(session.flow);
  return {
    message: "That's everything! I've highlighted the button to finish — click it whenever you're ready.",
    session,
    complete: false,
    formActions: submit ? [submit] : [],
  };
}

// Classify the visitor's reply to the auto-vs-tour question with the LLM (no
// keyword lists — works in any language and phrasing). Returns "guided" (bot
// fills it), "highlight" (visitor does it, bot points), "cancel", or "unclear".
async function classifyModeChoice(
  message: string,
  generate?: (system: string, prompt: string) => Promise<string>
): Promise<"guided" | "highlight" | "cancel" | "unclear"> {
  if (!generate) return "unclear";
  const prompt = `The assistant asked the user: "Should I fill in the form for you automatically, or show you where everything goes so you do it yourself?"

Classify the user's reply into exactly one of:
- "auto"      = they want the assistant to do it / fill it in for them
- "self"      = they want to be shown / guided / do it themselves
- "cancel"    = they no longer want to proceed / stop / never mind
- "unclear"   = none of the above, or ambiguous

User's reply: "${message}"

Respond with ONLY the single word: auto, self, cancel, or unclear.`;
  try {
    const raw = (await generate("You are a precise intent classifier. Reply with one word only.", prompt)).toLowerCase();
    if (/\bauto\b/.test(raw)) return "guided";
    if (/\bself\b/.test(raw)) return "highlight";
    if (/\bcancel\b/.test(raw)) return "cancel";
    return "unclear";
  } catch {
    return "unclear";
  }
}

async function handleModeChoice(
  session: FlowSession,
  userMessage: string,
  generate?: (system: string, prompt: string) => Promise<string>
): Promise<ConversationResponse> {
  const intent = await classifyModeChoice(userMessage, generate);
  if (intent === "cancel") {
    session.status = "failed";
    return { message: "No problem — I've cancelled that. What else can I help you with?", session, complete: true };
  }
  if (intent === "unclear") {
    return {
      message: 'Just let me know — should I fill it in for you, or show you where everything goes?',
      session,
      complete: false,
    };
  }
  const choice: "guided" | "highlight" = intent;
  session.executionMode = choice;
  // HIGHLIGHT mode is a chat-driven TOUR: highlight ONE field, wait for the
  // visitor to fill it and say "done", read the form state back, then advance.
  if (choice === "highlight") {
    return startTour(session);
  }
  const stillRequired = session.remainingInputs.filter((i) => i.required !== false);
  if (stillRequired.length === 0) {
    session.status = "executing";
    const submit = submitAction(session.flow);
    const sets = flowFields(session.flow).map((f) => setActionFor(session, f.name)).filter((a): a is FormAction => !!a);
    return {
      message: "Filling it in for you now — just click the highlighted button to confirm.",
      session,
      complete: false,
      formActions: submit ? [...sets, submit] : sets,
    };
  }
  session.status = "collecting";
  // Run any setup steps (navigation etc.) that come before the first field.
  const lead = leadingSetupSteps(session.flow).filter((st) => !(session.executedStepIds || []).includes(st.id));
  markExecuted(session, lead);
  const first = stillRequired[0];
  return {
    message: `Okay — I'll fill each field in as you give it to me. First: ${first.label}?`,
    session,
    complete: false,
    liveSteps: lead.length ? lead : undefined,
  };
}

async function handleConfirmation(
  session: FlowSession,
  userMessage: string
): Promise<ConversationResponse> {
  const lower = userMessage.toLowerCase();

  const affirmatives = ["yes", "y", "yeah", "yep", "sure", "go ahead", "do it", "confirm", "ok", "okay"];
  const negatives = ["no", "n", "nope", "cancel", "stop", "nevermind", "never mind"];

  const isYes = affirmatives.some((a) => lower.includes(a));
  const isNo = negatives.some((n) => lower.includes(n));

  if (isNo) {
    session.status = "failed";
    return {
      message: "No problem, I've cancelled the action. Let me know if there's anything else I can help with.",
      session,
      complete: true,
    };
  }

  if (!isYes) {
    return {
      message: `I didn't quite catch that. Should I go ahead and run "${session.flow.name}"? Please reply yes or no.`,
      session,
      complete: false,
    };
  }

  // Determine execution mode
  const needsUserAction = session.flow.steps.some((s) => s.requiresUserAction);
  const flowMode = session.flow.executionMode || "auto";
  const useGuided = flowMode === "guided" || (flowMode === "auto" && needsUserAction);

  session.executionMode = useGuided ? "guided" : "background";

  if (useGuided) {
    // Guided mode — send steps + inputs to the widget for client-side execution
    session.status = "executing";
    return {
      message: `I'll guide you through "${session.flow.name}" now. I'll fill in what I can automatically — you'll only need to handle the parts that require your direct action.`,
      session,
      complete: false, // not complete until the widget reports back
    };
  }

  // Background mode — execute via headless Playwright
  session.status = "executing";
  try {
    const options: ExecutionOptions = {
      inputs: session.collectedInputs,
      headless: true,
      defaultTimeout: 15000,
    };

    const result = await executeFlow(session.flow, options);
    session.result = result;

    if (result.success) {
      session.status = "done";
      return {
        message: `Done! I successfully completed "${session.flow.name}" (${result.stepsCompleted}/${result.totalSteps} steps in ${(result.totalDurationMs / 1000).toFixed(1)}s). Is there anything else I can help with?`,
        session,
        complete: true,
      };
    } else {
      session.status = "failed";
      return {
        message: `I ran into an issue while executing "${session.flow.name}": ${result.error}. Would you like me to try again or can I help with something else?`,
        session,
        complete: true,
      };
    }
  } catch (err) {
    session.status = "failed";
    return {
      message: `An unexpected error occurred: ${err instanceof Error ? err.message : String(err)}. Please try again later.`,
      session,
      complete: true,
    };
  }
}

/**
 * Attempts to extract multiple input values from a single user message.
 * Handles patterns like "My name is John and my email is john@test.com"
 */
function extractInputValues(
  remainingInputs: FlowInput[],
  message: string
): Record<string, string> {
  const extracted: Record<string, string> = {};

  for (const input of remainingInputs) {
    const value = tryExtractValue(input, message);
    if (value) {
      extracted[input.name] = value;
    }
  }

  return extracted;
}

function tryExtractValue(input: FlowInput, message: string): string | null {
  const lower = message.toLowerCase();

  // Check for explicit patterns like "my email is X" or "email: X"
  const nameVariants = [input.name, input.label.toLowerCase()];
  for (const name of nameVariants) {
    // Pattern: "my <name> is <value>"
    const myIsPattern = new RegExp(`my\\s+${escapeRegex(name)}\\s+is\\s+(.+?)(?:\\s+and\\s+|\\s*,\\s*|$)`, "i");
    const myIsMatch = message.match(myIsPattern);
    if (myIsMatch) return myIsMatch[1].trim();

    // Pattern: "<name>: <value>" or "<name> = <value>"
    const colonPattern = new RegExp(`${escapeRegex(name)}\\s*[:=]\\s*(.+?)(?:\\s+and\\s+|\\s*,\\s*|$)`, "i");
    const colonMatch = message.match(colonPattern);
    if (colonMatch) return colonMatch[1].trim();
  }

  // Type-based extraction
  switch (input.type) {
    case "email": {
      const emailMatch = message.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
      if (emailMatch) return emailMatch[0];
      break;
    }
    case "phone": {
      const phoneMatch = message.match(/[\d\s\-+()]{7,}/);
      if (phoneMatch) return phoneMatch[0].trim();
      break;
    }
    case "number": {
      const numMatch = message.match(/\d+(\.\d+)?/);
      if (numMatch) return numMatch[0];
      break;
    }
    case "date": {
      // Basic date patterns
      const dateMatch = message.match(/\d{1,4}[-/]\d{1,2}[-/]\d{1,4}/);
      if (dateMatch) return dateMatch[0];
      break;
    }
  }

  return null;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
