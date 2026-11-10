/**
 * Runs a business's knowledge audit and saves the report (tenants/<id>/knowledge-audit.json), which the panel
 * shows as optional hints ("Worth adding"). The audit's test questions are ours, not a customer's, so nothing
 * goes to the unanswered-questions list (D1 unknown_questions) - that list is only what customers asked.
 */
import type { AuditReport } from "./audit.js";

export async function runAndSaveAudit(
  tenantId: string,
  audit: () => Promise<AuditReport>,
  save: (key: string, body: string, contentType: string) => Promise<unknown>,
): Promise<AuditReport> {
  const report = await audit();
  await save(`tenants/${tenantId}/knowledge-audit.json`, JSON.stringify(report), "application/json");
  return report;
}
