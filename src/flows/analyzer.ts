import { ClaudeCLIProvider } from "../llm/claude-cli-provider.js";
import type { FlowDefinition, FlowInput, FlowStep } from "../context/types.js";

interface RawRecordedFlow {
  id: string;
  steps: RawStep[];
  startUrl: string;
  recordedAt: string;
}

interface RawStep {
  id: string;
  order: number;
  action: string;
  target: Record<string, string>;
  value?: string;
  description: string;
  url: string;
  timestamp: number;
}

export interface AnalyzedFlow {
  flow: FlowDefinition;
  summary: string;
}

const ANALYSIS_PROMPT = `You are a flow analyzer. You receive a raw recording of user interactions on a website (clicks, typing, navigation). Your job is to turn this into a structured, parameterized skill that a chatbot can execute on behalf of future users.

Analyze the recording and return a JSON object with these fields:

{
  "name": "Short skill name (e.g., 'Submit Application', 'Contact Form', 'Place Order')",
  "description": "One paragraph describing what this flow does, written for an end user",
  "triggerPhrases": ["5-10 natural phrases a user might say to trigger this flow, e.g., 'I want to apply', 'submit my application', 'sign up for the challenge'"],
  "requiredInputs": [
    {
      "name": "variableName",
      "label": "Human-readable label",
      "type": "text|email|phone|number|select|date",
      "required": true,
      "description": "What this field is for",
      "validation": "optional regex pattern"
    }
  ],
  "parameterizedSteps": [
    {
      "id": "step id from original",
      "order": 0,
      "action": "navigate|click|type|select|wait|scroll",
      "target": { "css": "...", "xpath": "...", "text": "..." },
      "value": "literal value OR {{variableName}} for parameterized inputs",
      "description": "Human-readable description of this step"
    }
  ],
  "summary": "A brief description of what was recorded and how it was parameterized"
}

Rules:
- Any typed value that looks user-specific (names, emails, phone numbers, addresses, messages, quantities) MUST become a {{variable}} parameter
- Button clicks, navigation, and checkbox/radio selections that are part of the fixed flow stay as literal values
- Dropdown selections that are user-specific (e.g., country, size) become parameters with type "select"
- Remove redundant steps (e.g., clicking a field before typing — just keep the type step)
- Merge consecutive type actions on the same field into one step
- The trigger phrases should be natural language that a website visitor would actually say
- The description should explain what happens WITHOUT requiring the user to understand the steps
- Give each input a clear, user-friendly label (not a CSS selector name)

Return ONLY the JSON object, no markdown, no explanation.`;

export async function analyzeRecordedFlow(
  rawFlow: RawRecordedFlow,
  options: {
    model?: string;
    // Injectable LLM call — the multi-tenant server passes an OpenRouter-backed
    // generate (the Claude CLI default only works on a dev machine).
    generate?: (system: string, prompt: string) => Promise<string>;
  } = {}
): Promise<AnalyzedFlow> {
  const generate =
    options.generate ||
    (async (system: string, prompt: string) => {
      const cli = new ClaudeCLIProvider({ mode: "local", model: options.model || "sonnet" });
      return cli.generate(system, prompt);
    });

  const prompt = `${ANALYSIS_PROMPT}

Here is the raw recorded flow from ${rawFlow.startUrl} (recorded at ${rawFlow.recordedAt}):

${JSON.stringify(rawFlow.steps, null, 2)}`;

  const response = await generate(
    "You are a precise JSON generator. Output only valid JSON, nothing else.",
    prompt
  );

  // Extract JSON from response (handle potential markdown wrapping)
  let jsonStr = response.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  const analysis = JSON.parse(jsonStr);

  const flow: FlowDefinition = {
    id: rawFlow.id,
    name: analysis.name,
    description: analysis.description,
    triggerPhrases: analysis.triggerPhrases || [],
    steps: (analysis.parameterizedSteps || []).map((step: any, i: number) => ({
      id: step.id || `step_${i}`,
      order: step.order ?? i,
      action: step.action,
      target: step.target || {},
      value: step.value,
      description: step.description || "",
      timeout: step.timeout,
    })),
    requiredInputs: (analysis.requiredInputs || []).map((input: any) => ({
      name: input.name,
      label: input.label,
      type: input.type || "text",
      required: input.required ?? true,
      description: input.description || "",
      validation: input.validation,
    })),
    createdAt: rawFlow.recordedAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
  };

  return {
    flow,
    summary: analysis.summary || `Analyzed ${rawFlow.steps.length} steps into skill "${flow.name}" with ${flow.requiredInputs.length} parameters.`,
  };
}
