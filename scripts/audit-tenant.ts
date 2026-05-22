/**
 * Single-tenant audit — spawned by weekly-audit.ts as an independent process.
 * Exits with stdout "emailed" | "skipped" | "clean".
 *
 * Usage: node --import tsx scripts/audit-tenant.ts <tenantId>
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync } from "fs";
import { writeFile } from "fs/promises";
import { getTenant } from "../src/multi-tenant/tenant-registry.js";
import { generateGapEmail } from "../src/multi-tenant/business-audit.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(__dirname, "../data");
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM = process.env.EMAIL_FROM || "Jakub <jakub@whisp.so>";
const BASE_URL = process.env.BASE_URL || "https://whisp.so";

const tenantId = process.argv[2];
if (!tenantId) {
  console.error("Usage: audit-tenant.ts <tenantId>");
  process.exit(1);
}

async function main() {
  const tenant = getTenant(tenantId);
  if (!tenant || tenant.status !== "active") {
    console.log("skipped");
    process.exit(0);
  }

  const tenantDir = resolve(DATA_ROOT, tenantId);
  const bizInfoPath = resolve(tenantDir, "business-info.json");

  if (!existsSync(bizInfoPath)) {
    console.log("skipped");
    process.exit(0);
  }

  let gaps: string[] = [];
  try {
    const info = JSON.parse(readFileSync(bizInfoPath, "utf-8"));
    gaps = info.gaps || [];
  } catch {
    console.log("skipped");
    process.exit(0);
  }

  if (gaps.length === 0) {
    console.log("clean");
    process.exit(0);
  }

  // Check if already emailed this week
  const lastEmailPath = resolve(tenantDir, "last-gap-email.json");
  if (existsSync(lastEmailPath)) {
    try {
      const lastEmail = JSON.parse(readFileSync(lastEmailPath, "utf-8"));
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      if (new Date(lastEmail.sentAt).getTime() > weekAgo) {
        console.log("skipped");
        process.exit(0);
      }
    } catch {}
  }

  // Generate and send
  const emailContent = generateGapEmail(tenant.domain, gaps, `${BASE_URL}/auth/login`);
  if (!emailContent || !tenant.email) {
    console.log("skipped");
    process.exit(0);
  }

  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${RESEND_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM,
        to: [tenant.email],
        subject: emailContent.subject,
        html: emailContent.html,
        reply_to: "jakub@whisp.so",
      }),
    });

    if (resp.ok) {
      await writeFile(lastEmailPath, JSON.stringify({
        sentAt: new Date().toISOString(),
        gaps,
      }));
      console.log("emailed");
    } else {
      console.log("skipped");
    }
  } catch {
    console.log("skipped");
  }
}

main().catch(() => {
  console.log("skipped");
  process.exit(0);
});
