/**
 * Multi-tenant infrastructure — barrel export.
 */

export { getDb, closeDb } from "./db/connection.js";
export { runMigrations } from "./db/migrations.js";
export {
  createTenant,
  ensureTenant,
  getTenant,
  getTenantByDomain,
  updateTenant,
  listTenants,
  deleteTenant,
  hydrateRegistry,
} from "./tenant-registry.js";
export type { TenantRecord } from "./tenant-registry.js";
export {
  hashPassword,
  verifyPassword,
  createSession,
  validateSession,
  generateApiKey,
} from "./auth.js";
export { scrapeTenant } from "./scrape-pipeline.js";
export type { ScrapePipelineResult } from "./scrape-pipeline.js";
export { ScrapeWorker } from "./background-worker.js";
export { TenantManager } from "./tenant-manager.js";
export { sendWelcomeEmail, sendBotReadyEmail } from "./email.js";
