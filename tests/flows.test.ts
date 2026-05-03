import { describe, it, expect } from "vitest";
import { executeFlow, substituteVariables } from "../src/flows/executor.js";
import type { FlowDefinition } from "../src/context/types.js";

describe("substituteVariables", () => {
  it("replaces single variable", () => {
    expect(substituteVariables("Hello {{name}}", { name: "World" })).toBe(
      "Hello World"
    );
  });

  it("replaces multiple variables", () => {
    expect(
      substituteVariables("{{first}} {{last}}", {
        first: "John",
        last: "Doe",
      })
    ).toBe("John Doe");
  });

  it("leaves unresolved variables untouched", () => {
    expect(substituteVariables("{{unknown}}", {})).toBe("{{unknown}}");
  });

  it("handles strings with no variables", () => {
    expect(substituteVariables("plain text", { name: "val" })).toBe(
      "plain text"
    );
  });
});

describe("executeFlow", () => {
  it("navigates to httpbin forms page and fills a form", async () => {
    const flow: FlowDefinition = {
      id: "test-flow-1",
      name: "Fill httpbin form",
      description: "Navigate to httpbin form and fill it out",
      triggerPhrases: ["fill form"],
      steps: [
        {
          id: "step_1",
          order: 1,
          action: "navigate",
          target: { css: "window" },
          value: "https://httpbin.org/forms/post",
          description: "Navigate to form page",
          timeout: 15000,
        },
        {
          id: "step_2",
          order: 2,
          action: "type",
          target: { css: 'input[name="custname"]' },
          value: "{{name}}",
          description: "Type customer name",
          timeout: 10000,
        },
        {
          id: "step_3",
          order: 3,
          action: "type",
          target: { css: 'input[name="custtel"]' },
          value: "{{phone}}",
          description: "Type customer telephone",
          timeout: 10000,
        },
        {
          id: "step_4",
          order: 4,
          action: "type",
          target: { css: 'input[name="custemail"]' },
          value: "{{email}}",
          description: "Type customer email",
          timeout: 10000,
        },
        {
          id: "step_5",
          order: 5,
          action: "click",
          target: { css: 'input[name="size"][value="medium"]' },
          value: undefined,
          description: "Select medium pizza size",
          timeout: 10000,
        },
        {
          id: "step_6",
          order: 6,
          action: "click",
          target: { css: 'input[name="topping"][value="cheese"]' },
          value: undefined,
          description: "Select cheese topping",
          timeout: 10000,
        },
        {
          id: "step_7",
          order: 7,
          action: "type",
          target: { css: 'textarea[name="comments"]' },
          value: "Test comment from flow executor",
          description: "Type delivery instructions",
          timeout: 10000,
        },
      ],
      requiredInputs: [
        {
          name: "name",
          label: "Customer Name",
          type: "text",
          required: true,
          description: "Customer name for the order",
        },
        {
          name: "phone",
          label: "Phone Number",
          type: "phone",
          required: true,
          description: "Customer phone number",
        },
        {
          name: "email",
          label: "Email",
          type: "email",
          required: true,
          description: "Customer email",
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "active",
    };

    const result = await executeFlow(flow, {
      inputs: {
        name: "Test User",
        phone: "555-1234",
        email: "test@example.com",
      },
      headless: true,
      defaultTimeout: 15000,
    });

    expect(result.success).toBe(true);
    expect(result.stepsCompleted).toBe(7);
    expect(result.totalSteps).toBe(7);
    expect(result.stepResults).toHaveLength(7);
    expect(result.stepResults.every((s) => s.success)).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.totalDurationMs).toBeGreaterThan(0);
  }, 60000);

  it("handles timeout gracefully when element not found", async () => {
    const flow: FlowDefinition = {
      id: "test-flow-timeout",
      name: "Timeout test",
      description: "Should fail gracefully on missing element",
      triggerPhrases: [],
      steps: [
        {
          id: "step_1",
          order: 1,
          action: "navigate",
          target: { css: "window" },
          value: "https://httpbin.org/forms/post",
          description: "Navigate to form page",
          timeout: 15000,
        },
        {
          id: "step_2",
          order: 2,
          action: "click",
          target: { css: "#nonexistent-element-xyz" },
          description: "Click non-existent element",
          timeout: 3000,
        },
      ],
      requiredInputs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "draft",
    };

    const result = await executeFlow(flow, {
      headless: true,
      defaultTimeout: 3000,
    });

    expect(result.success).toBe(false);
    expect(result.stepsCompleted).toBe(1); // navigate succeeded
    expect(result.error).toContain("Step 2");
    expect(result.stepResults[0].success).toBe(true);
    expect(result.stepResults[1].success).toBe(false);
  }, 60000);

  it("uses fallback selectors when primary selector fails", async () => {
    const flow: FlowDefinition = {
      id: "test-flow-fallback",
      name: "Fallback selector test",
      description: "Should fallback to text selector",
      triggerPhrases: [],
      steps: [
        {
          id: "step_1",
          order: 1,
          action: "navigate",
          target: { css: "window" },
          value: "https://httpbin.org/forms/post",
          description: "Navigate to form page",
          timeout: 15000,
        },
        {
          id: "step_2",
          order: 2,
          action: "type",
          target: {
            testId: "nonexistent-testid",
            ariaLabel: "nonexistent-aria",
            css: 'input[name="custname"]',
          },
          value: "Fallback Test",
          description: "Type using fallback CSS selector",
          timeout: 10000,
        },
      ],
      requiredInputs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "draft",
    };

    const result = await executeFlow(flow, {
      headless: true,
      defaultTimeout: 10000,
    });

    expect(result.success).toBe(true);
    expect(result.stepsCompleted).toBe(2);
    // The CSS selector should have been used as fallback
    const step2 = result.stepResults[1];
    expect(step2.success).toBe(true);
    expect(step2.selectorUsed).toContain("css");
  }, 60000);
});
