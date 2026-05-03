import { chromium, type Browser, type Page, type BrowserContext } from "playwright";
import type {
  FlowDefinition,
  FlowStep,
  ElementSelector,
} from "../context/types.js";

export interface ExecutionOptions {
  /** Input values to substitute for {{variable}} placeholders */
  inputs?: Record<string, string>;
  /** Take screenshots after each step (for debugging) */
  screenshots?: boolean;
  /** Directory to save screenshots to */
  screenshotDir?: string;
  /** Whether to run headless (default: true) */
  headless?: boolean;
  /** Default timeout per step in ms (default: 10000) */
  defaultTimeout?: number;
  /** Whether to wait for network idle after navigation actions */
  waitForNetworkIdle?: boolean;
}

export interface StepResult {
  stepId: string;
  order: number;
  action: string;
  success: boolean;
  error?: string;
  durationMs: number;
  screenshotPath?: string;
  selectorUsed?: string;
}

export interface ExecutionResult {
  flowId: string;
  flowName: string;
  success: boolean;
  stepsCompleted: number;
  totalSteps: number;
  stepResults: StepResult[];
  totalDurationMs: number;
  error?: string;
}

/**
 * Substitutes {{variable}} placeholders in a string with provided input values
 */
export function substituteVariables(
  value: string,
  inputs: Record<string, string>
): string {
  return value.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    if (name in inputs) return inputs[name];
    return match; // leave unresolved placeholders as-is
  });
}

/**
 * Resolves an element on the page using multiple selector strategies in priority order.
 * Returns the locator that worked and its description.
 */
async function resolveElement(
  page: Page,
  selector: ElementSelector,
  timeout: number
): Promise<{ locator: ReturnType<Page["locator"]>; locatorDescription: string }> {
  // Priority order: testId > ariaLabel > css > xpath > text
  const strategies: Array<{
    name: string;
    locate: () => ReturnType<Page["locator"]>;
  }> = [];

  if (selector.testId) {
    strategies.push({
      name: `testId: ${selector.testId}`,
      locate: () => page.getByTestId(selector.testId!),
    });
  }

  if (selector.ariaLabel) {
    strategies.push({
      name: `ariaLabel: ${selector.ariaLabel}`,
      locate: () => page.getByLabel(selector.ariaLabel!),
    });
  }

  if (selector.css && selector.css !== "window") {
    strategies.push({
      name: `css: ${selector.css}`,
      locate: () => page.locator(selector.css!),
    });
  }

  if (selector.xpath) {
    strategies.push({
      name: `xpath: ${selector.xpath}`,
      locate: () => page.locator(`xpath=${selector.xpath}`),
    });
  }

  if (selector.text) {
    strategies.push({
      name: `text: ${selector.text}`,
      locate: () => page.getByText(selector.text!, { exact: false }),
    });
  }

  // Use a short per-strategy timeout so fallbacks are tried quickly.
  // If there's only one strategy, give it the full timeout.
  const perStrategyTimeout =
    strategies.length > 1 ? Math.min(2000, Math.floor(timeout / strategies.length)) : timeout;

  for (const strategy of strategies) {
    try {
      const locator = strategy.locate();
      await locator.first().waitFor({ state: "visible", timeout: perStrategyTimeout });
      return { locator, locatorDescription: strategy.name };
    } catch {
      // Try next strategy
      continue;
    }
  }

  throw new Error(
    `Could not find element with any selector: ${JSON.stringify(selector)}`
  );
}


/**
 * Executes a single flow step
 */
async function executeStep(
  page: Page,
  step: FlowStep,
  inputs: Record<string, string>,
  timeout: number
): Promise<{ selectorUsed: string }> {
  const stepTimeout = step.timeout || timeout;

  // Handle navigate action specially — it targets the page URL, not an element
  if (step.action === "navigate") {
    const url = step.value ? substituteVariables(step.value, inputs) : "";
    if (url && url !== "window") {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: stepTimeout,
      });
    }
    return { selectorUsed: "navigate" };
  }

  // For element-targeting actions, resolve the element first
  const { locator, locatorDescription } = await resolveElement(page, step.target, stepTimeout);

  switch (step.action) {
    case "click":
      await locator.first().click({ timeout: stepTimeout });
      break;

    case "type": {
      const value = step.value ? substituteVariables(step.value, inputs) : "";
      await locator.first().fill(value, { timeout: stepTimeout });
      break;
    }

    case "select": {
      const value = step.value ? substituteVariables(step.value, inputs) : "";
      await locator.first().selectOption(value, { timeout: stepTimeout });
      break;
    }

    case "wait":
      await locator.first().waitFor({
        state: "visible",
        timeout: stepTimeout,
      });
      break;

    case "assert":
      await locator.first().waitFor({
        state: "visible",
        timeout: stepTimeout,
      });
      break;

    case "scroll":
      await locator.first().scrollIntoViewIfNeeded({ timeout: stepTimeout });
      break;

    default:
      throw new Error(`Unknown action: ${step.action}`);
  }

  return { selectorUsed: locatorDescription };
}


/**
 * Executes a recorded flow using Playwright
 */
export async function executeFlow(
  flow: FlowDefinition,
  options: ExecutionOptions = {}
): Promise<ExecutionResult> {
  const {
    inputs = {},
    screenshots = false,
    screenshotDir = "./screenshots",
    headless = true,
    defaultTimeout = 10000,
  } = options;

  const startTime = Date.now();
  const stepResults: StepResult[] = [];
  let browser: Browser | null = null;
  let context: BrowserContext | null = null;

  try {
    browser = await chromium.launch({ headless });
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
    });
    const page = await context.newPage();

    // Sort steps by order
    const sortedSteps = [...flow.steps].sort((a, b) => a.order - b.order);

    for (const step of sortedSteps) {
      const stepStart = Date.now();
      let stepResult: StepResult;

      try {
        const { selectorUsed } = await executeStep(
          page,
          step,
          inputs,
          defaultTimeout
        );

        // Wait briefly for any triggered navigation/animations
        if (
          step.action === "click" ||
          step.action === "navigate"
        ) {
          try {
            await page.waitForLoadState("domcontentloaded", { timeout: 3000 });
          } catch {
            // Not all clicks trigger navigation — that's fine
          }
        }

        stepResult = {
          stepId: step.id,
          order: step.order,
          action: step.action,
          success: true,
          durationMs: Date.now() - stepStart,
          selectorUsed,
        };

        // Take screenshot if enabled
        if (screenshots) {
          const screenshotPath = `${screenshotDir}/step-${step.order}.png`;
          await page.screenshot({ path: screenshotPath });
          stepResult.screenshotPath = screenshotPath;
        }
      } catch (err) {
        stepResult = {
          stepId: step.id,
          order: step.order,
          action: step.action,
          success: false,
          error: err instanceof Error ? err.message : String(err),
          durationMs: Date.now() - stepStart,
        };

        stepResults.push(stepResult);

        return {
          flowId: flow.id,
          flowName: flow.name,
          success: false,
          stepsCompleted: stepResults.filter((r) => r.success).length,
          totalSteps: sortedSteps.length,
          stepResults,
          totalDurationMs: Date.now() - startTime,
          error: `Step ${step.order} (${step.action}) failed: ${stepResult.error}`,
        };
      }

      stepResults.push(stepResult);
    }

    return {
      flowId: flow.id,
      flowName: flow.name,
      success: true,
      stepsCompleted: stepResults.length,
      totalSteps: sortedSteps.length,
      stepResults,
      totalDurationMs: Date.now() - startTime,
    };
  } catch (err) {
    return {
      flowId: flow.id,
      flowName: flow.name,
      success: false,
      stepsCompleted: stepResults.filter((r) => r.success).length,
      totalSteps: flow.steps.length,
      stepResults,
      totalDurationMs: Date.now() - startTime,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}
