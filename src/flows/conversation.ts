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
  status: "collecting" | "confirming" | "choosing" | "executing" | "done" | "failed";
  result?: ExecutionResult;
  executionMode?: "background" | "guided" | "highlight";
  // Step ids already sent to the widget for live (incremental) execution.
  executedStepIds?: string[];
  executedInputNames?: string[];
}

export interface ConversationResponse {
  message: string;
  session: FlowSession;
  // Steps the widget should execute RIGHT NOW (incremental live execution —
  // each collected input lands on the page immediately).
  liveSteps?: FlowStep[];
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
  generate?: (system: string, prompt: string) => Promise<string>
): Promise<ConversationResponse> {
  const msg = userMessage.trim();

  if (session.status === "confirming") {
    return handleConfirmation(session, msg);
  }

  if (session.status === "choosing") {
    return handleModeChoice(session, msg);
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
    // ("guide me through", "do it for me") mid-collection. Record the choice and
    // keep collecting; the mode question at the end is then skipped.
    if (Object.keys(session.collectedInputs).length === collectedBefore) {
      const midChoice = parseModeChoice(userMessage);
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
    const fallbackChoice = parseModeChoice(userMessage);
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

  // Live incremental execution: the steps bound to just-collected inputs go to
  // the widget NOW, so each answer visibly lands on the page.
  const newlyCollectedAll = Object.keys(session.collectedInputs).filter(
    (n) => !(session.executedInputNames || (session.executedInputNames = [])).includes(n)
  );
  const liveNow = stepsBoundToInputs(session.flow, newlyCollectedAll)
    .filter((st) => !(session.executedStepIds || []).includes(st.id));
  markExecuted(session, liveNow);
  session.executedInputNames = [...(session.executedInputNames || []), ...newlyCollectedAll];

  // Still need more? Only REQUIRED inputs gate completion — optional fields
  // (e.g. "Special notes") are picked up when the visitor volunteers them, but
  // never block the flow (they used to trap the session in collecting forever).
  const stillRequired = session.remainingInputs.filter((i) => i.required !== false);
  if (stillRequired.length > 0) {
    const still = stillRequired.map((i) => i.label).join(", ");
    return {
      message: `I still need: ${still}. Could you provide ${stillRequired.length === 1 ? "it" : "them"}?`,
      session,
      complete: false,
      liveSteps: liveNow.length ? liveNow : undefined,
    };
  }
  session.remainingInputs = [];

  // All collected — let the VISITOR choose how it happens: the bot does it for
  // them, or highlights each step so they do it themselves. If they already
  // said so mid-collection, don't ask again.
  const summary = Object.entries(session.collectedInputs)
    .map(([key, val]) => {
      const input = allNeeded.find((i) => i.name === key);
      return `- ${input?.label || key}: ${val}`;
    })
    .join("\n");

  if (session.executionMode === "highlight" || session.executionMode === "guided") {
    session.status = "executing";
    const finalBatch = unexecutedSteps(session);
    markExecuted(session, finalBatch);
    const merged = liveNow.length ? [...liveNow, ...finalBatch.filter((st) => !liveNow.some((l) => l.id === st.id))] : finalBatch;
    return {
      message: session.executionMode === "highlight"
        ? `Got it!\n${summary}\n\nLast bit — follow the highlights to finish up.`
        : `Got it!\n${summary}\n\nFinishing up on the page now.`,
      session,
      complete: false,
      liveSteps: merged,
    };
  }

  session.status = "choosing";
  return {
    message: `Got it!\n${summary}\n\nShould I fill this in for you automatically, or show you where everything goes so you do it yourself?`,
    session,
    complete: false,
  };
}

function parseModeChoice(msg: string): "guided" | "highlight" | null {
  const m = " " + msg.toLowerCase() + " ";
  const show = ["show", "highlight", "guide", "myself", "i'll do", "i will do", "pokaz", "pokaż", "poprowadz", "poprowadź", " sam ", " sama ", "ja to"];
  const auto = ["do it", "fill", "for me", "automat", "you do", "zrob", "zrób", "wypelnij", "wypełnij", "za mnie", "ty to", "yes", "tak"];
  if (show.some((w) => m.includes(w))) return "highlight";
  if (auto.some((w) => m.includes(w))) return "guided";
  return null;
}

async function handleModeChoice(
  session: FlowSession,
  userMessage: string
): Promise<ConversationResponse> {
  const lower = userMessage.toLowerCase().trim();
  const cancelWords = ["cancel", "stop", "quit", "nevermind", "never mind", "anuluj", "przerwij", "rezygnuje", "rezygnuję"];
  if (cancelWords.some((w) => lower === w || lower.startsWith(w + " "))) {
    session.status = "failed";
    return { message: "No problem — I've cancelled that. What else can I help you with?", session, complete: true };
  }
  const choice = parseModeChoice(userMessage);
  if (!choice) {
    // Second chance, then fall back to the flow's own default.
    const fallback = session.flow.executionMode === "highlight" ? "highlight" : null;
    if (fallback) {
      session.executionMode = fallback;
      session.status = "executing";
      return { message: "I'll show you where everything goes — follow the highlights on the page.", session, complete: false };
    }
    return {
      message: 'Just tell me: "do it for me" or "show me how".',
      session,
      complete: false,
    };
  }
  session.executionMode = choice;
  // HIGHLIGHT mode is a guided TOUR: no chat collection at all — the visitor
  // types into the real fields themselves, the executor highlights each one and
  // advances on their input. Collecting values first just to ask the visitor to
  // retype them made no sense (live feedback, 2026-07-20).
  if (choice === "highlight") {
    session.status = "executing";
    const tour = unexecutedSteps(session);
    markExecuted(session, tour);
    return {
      message: "Follow the highlights on the page — I'll walk you through each field, one at a time.",
      session,
      complete: false,
      liveSteps: tour,
    };
  }
  const stillRequired = session.remainingInputs.filter((i) => i.required !== false);
  if (stillRequired.length === 0) {
    session.status = "executing";
    const live = unexecutedSteps(session);
    markExecuted(session, live);
    return {
      message: "I'll fill it in for you now — switching to the page.",
      session,
      complete: false,
      liveSteps: live,
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
