/**
 * Weekly Business Audit Runner — spawns independent audit for each tenant.
 * Each tenant gets its own process so one failure doesn't block others.
 *
 * Run via cron: node --import tsx scripts/weekly-audit.ts
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { spawn } from "child_process";
import { listTenants } from "../src/multi-tenant/tenant-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONCURRENCY = 5;
const TENANT_SCRIPT = resolve(__dirname, "audit-tenant.ts");

async function main() {
  const tenants = listTenants().filter(t => t.status === "active" && t.chunksCount > 0);
  console.log(`[weekly-audit] ${tenants.length} active tenants to audit`);

  let completed = 0;
  let emailed = 0;
  let failed = 0;
  let skipped = 0;

  // Process in batches of CONCURRENCY
  for (let i = 0; i < tenants.length; i += CONCURRENCY) {
    const batch = tenants.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map(t => runTenantAudit(t.id))
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        if (r.value === "emailed") emailed++;
        else if (r.value === "skipped") skipped++;
        else completed++;
      } else {
        failed++;
      }
    }

    console.log(`[weekly-audit] Progress: ${Math.min(i + CONCURRENCY, tenants.length)}/${tenants.length} (${emailed} emailed, ${failed} failed)`);
  }

  console.log(`[weekly-audit] Done: ${completed} clean, ${emailed} emailed, ${skipped} skipped, ${failed} failed`);
}

function runTenantAudit(tenantId: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["--import", "tsx", TENANT_SCRIPT, tenantId], {
      cwd: dirname(__dirname),
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => stdout += d);
    child.stderr.on("data", d => stderr += d);

    child.on("close", code => {
      if (code === 0) {
        const result = stdout.trim().split("\n").pop() || "";
        resolve(result); // "emailed", "skipped", or "clean"
      } else {
        reject(new Error(`${tenantId}: exit ${code} — ${stderr.slice(0, 100)}`));
      }
    });

    child.on("error", reject);
  });
}

main().catch(console.error);
