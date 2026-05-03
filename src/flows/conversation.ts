import type { FlowDefinition, FlowInput } from "../context/types.js";
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
  status: "collecting" | "confirming" | "executing" | "done" | "failed";
  result?: ExecutionResult;
  executionMode?: "background" | "guided";
}

export interface ConversationResponse {
  message: string;
  session: FlowSession;
  /** When true, the flow has finished executing (success or failure) */
  complete: boolean;
}

/**
 * Starts a new flow session and returns the first question to ask the user.
 */
export function startFlowSession(flow: FlowDefinition): ConversationResponse {
  const session: FlowSession = {
    flowId: flow.id,
    flow,
    collectedInputs: {},
    remainingInputs: [...flow.requiredInputs],
    status: "collecting",
  };

  if (session.remainingInputs.length === 0) {
    // No inputs needed — go straight to confirmation
    session.status = "confirming";
    return {
      message: `I can run "${flow.name}" for you. There are no additional details needed. Should I go ahead and execute it?`,
      session,
      complete: false,
    };
  }

  const firstInput = session.remainingInputs[0];
  const inputList = flow.requiredInputs
    .map((i) => `- ${i.label} (${i.type})`)
    .join("\n");

  return {
    message: `I'll help you with "${flow.name}". I need a few details:\n${inputList}\n\nLet's start — what is your ${firstInput.label.toLowerCase()}?`,
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
  userMessage: string
): Promise<ConversationResponse> {
  const msg = userMessage.trim();

  if (session.status === "confirming") {
    return handleConfirmation(session, msg);
  }

  if (session.status === "collecting") {
    return handleInputCollection(session, msg);
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
  userMessage: string
): Promise<ConversationResponse> {
  // Use LLM to extract all possible values from the user's message
  const allNeeded = session.flow.requiredInputs;
  const remaining = session.remainingInputs;

  const cli = new ClaudeCLIProvider({ mode: "local", model: "haiku" });

  const inputSpec = remaining.map((i) => `- "${i.name}" (${i.type}): ${i.label} — ${i.description || ""}`).join("\n");

  const parsePrompt = `Extract values for these fields from the user's message. Return ONLY a JSON object with field names as keys and extracted values as strings. If a field's value is not found in the message, omit it from the JSON. Do not invent values.

Fields to extract:
${inputSpec}

User's message: "${userMessage}"

Return only valid JSON, nothing else.`;

  try {
    const response = await cli.generate("You are a JSON extractor. Output only valid JSON.", parsePrompt);
    let jsonStr = response.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();

    const extracted = JSON.parse(jsonStr) as Record<string, string>;

    const sanitizationErrors: string[] = [];
    for (const [name, value] of Object.entries(extracted)) {
      if (value && remaining.some((i) => i.name === name)) {
        const inputDef = remaining.find((i) => i.name === name)!;
        const result = sanitizeFlowInput(String(value), inputDef);
        if (result.valid) {
          session.collectedInputs[name] = result.value;
          session.remainingInputs = session.remainingInputs.filter((i) => i.name !== name);
        } else {
          sanitizationErrors.push(result.error || `Invalid value for ${inputDef.label}`);
        }
      }
    }

    if (sanitizationErrors.length > 0) {
      return {
        message: sanitizationErrors.join("\n") + "\n\nCould you please provide valid values?",
        session,
        complete: false,
      };
    }
  } catch {
    // LLM parse failed — fall back to treating the whole message as the current field's value
    if (remaining.length > 0) {
      const current = remaining[0];
      const result = sanitizeFlowInput(userMessage.trim(), current);
      if (result.valid) {
        session.collectedInputs[current.name] = result.value;
        session.remainingInputs = session.remainingInputs.filter((i) => i.name !== current.name);
      } else {
        return {
          message: result.error || `That doesn't look right. Could you try again?`,
          session,
          complete: false,
        };
      }
    }
  }

  // Still need more?
  if (session.remainingInputs.length > 0) {
    const still = session.remainingInputs.map((i) => i.label).join(", ");
    return {
      message: `I still need: ${still}. Could you provide ${session.remainingInputs.length === 1 ? "it" : "them"}?`,
      session,
      complete: false,
    };
  }

  // All collected — execute
  session.status = "executing";
  session.executionMode = "guided";

  const summary = Object.entries(session.collectedInputs)
    .map(([key, val]) => {
      const input = allNeeded.find((i) => i.name === key);
      return `- ${input?.label || key}: ${val}`;
    })
    .join("\n");

  return {
    message: `Got it! I'll fill in the form for you now.\n${summary}`,
    session,
    complete: false,
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
