/**
 * Weekly Business Audit — self-questions each tenant's bot, finds gaps,
 * emails the business owner with missing info + dashboard link.
 *
 * Run via cron: node --import tsx scripts/weekly-audit.ts
 * Or: yalc-gtm agent:run --agent weekly-audit
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { listTenants, getTenant } from "../src/multi-tenant/tenant-registry.js";
import { auditBusinessInfo, generateGapEmail } from "../src/multi-tenant/business-audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(__dirname, "../data");

const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM = process.env.EMAIL_FROM || "Jakub <jakub@whisp.so>";
const BASE_URL = process.env.BASE_URL || "https://whisp.so";

async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: FROM, to: [to], subject, html, reply_to: "jakub@whisp.so" }),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function main() {
  const tenants = listTenants().filter(t => t.status === "active" && t.chunksCount > 0);
  console.log(`[weekly-audit] Auditing ${tenants.length} active tenants`);

  let audited = 0;
  let emailed = 0;
  let skipped = 0;

  for (const tenant of tenants) {
    const tenantDir = resolve(DATA_ROOT, tenant.id);
    const metaPath = resolve(tenantDir, "context-meta.json");

    if (!existsSync(metaPath)) {
      skipped++;
      continue;
    }

    // Load chunks from context meta to audit
    const bizInfoPath = resolve(tenantDir, "business-info.json");
    let gaps: string[] = [];

    if (existsSync(bizInfoPath)) {
      try {
        const info = JSON.parse(readFileSync(bizInfoPath, "utf-8"));
        gaps = info.gaps || [];
      } catch {}
    } else {
      // No business info yet — need to run audit on the chunks
      // For now, skip — audit happens during scrape
      skipped++;
      continue;
    }

    if (gaps.length === 0) {
      audited++;
      continue;
    }

    // Check if we already sent a gap email this week
    const lastEmailPath = resolve(tenantDir, "last-gap-email.json");
    if (existsSync(lastEmailPath)) {
      try {
        const lastEmail = JSON.parse(readFileSync(lastEmailPath, "utf-8"));
        const lastSent = new Date(lastEmail.sentAt).getTime();
        const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
        if (lastSent > weekAgo) {
          skipped++;
          continue; // Already emailed this week
        }
      } catch {}
    }

    // Generate and send gap email
    const dashboardUrl = `${BASE_URL}/auth/login`;
    const emailContent = generateGapEmail(tenant.domain, gaps, dashboardUrl);

    if (!emailContent || !tenant.email) {
      skipped++;
      continue;
    }

    const sent = await sendEmail(tenant.email, emailContent.subject, emailContent.html);
    if (sent) {
      emailed++;
      await writeFile(lastEmailPath, JSON.stringify({
        sentAt: new Date().toISOString(),
        gaps,
      }));
      console.log(`[weekly-audit] Emailed ${tenant.domain}: ${gaps.length} gaps`);
    } else {
      console.log(`[weekly-audit] Failed to email ${tenant.domain}`);
    }

    audited++;

    // Rate limit
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[weekly-audit] Done: ${audited} audited, ${emailed} emailed, ${skipped} skipped`);
}

main().catch(console.error);
