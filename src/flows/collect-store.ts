/**
 * "In chat" flows for a tenant: the default inquiry form every business can
 * fall back to - when a customer wants something no specific flow covers, or
 * when another business's bot refers a customer (ecosystem). The customer's
 * confirmed request goes to the owner (recordInquiry in tenant-manager).
 */
import type { FlowDefinition } from "../context/types.js";
import { getFlows, saveFlow } from "./flow-store.js";
import { deriveFields } from "./collect.js";
import { OpenRouterProvider } from "../llm/openrouter-provider.js";

export const DEFAULT_INQUIRY = {
  name: "Zapytanie / zamówienie",
  description: "Przyjmij zapytanie lub zamówienie klienta i przekaż je właścicielowi firmy: czego klient potrzebuje (produkt lub usługa, ilość albo zakres prac), termin, miejsce realizacji lub adres dostawy, imię i nazwisko oraz telefon.",
};

/** The fields an "in chat" flow collects, derived from the owner's description. */
export async function collectFieldsFor(description: string) {
  const or = new OpenRouterProvider({ maxTokens: 800, temperature: 0 });
  return deriveFields(description, async (system, user, maxTokens) => (await or.chat([{ role: "system", content: system }, { role: "user", content: user }], { maxTokens })).content);
}

/**
 * The tenant's active "in chat" flow - an existing one (the owner's own wording
 * wins), or the default inquiry form, created now. onChanged: evict the
 * tenant's cached chat so it picks the new flow up.
 */
export async function ensureCollectFlow(tenantId: string, onChanged?: (tenantId: string) => void): Promise<FlowDefinition> {
  const flows = await getFlows(tenantId, { fresh: true });
  const existing = flows.find((f) => f.executionMode === "collect" && f.status === "active");
  if (existing) return existing;
  const now = new Date().toISOString();
  const flow: FlowDefinition = {
    id: `collect_default_${Date.now().toString(36)}`,
    name: DEFAULT_INQUIRY.name,
    description: DEFAULT_INQUIRY.description,
    triggerPhrases: [],
    steps: [],
    requiredInputs: await collectFieldsFor(DEFAULT_INQUIRY.description),
    createdAt: now,
    updatedAt: now,
    status: "active",
    executionMode: "collect",
  };
  await saveFlow(tenantId, flow);
  onChanged?.(tenantId);
  console.log(`[flows] ${tenantId}: default inquiry flow created (${flow.requiredInputs.map((i) => i.name).join(", ")})`);
  return flow;
}
