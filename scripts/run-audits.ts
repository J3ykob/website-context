/**
 * Run business info audit on all existing tenants using their Qdrant chunks.
 * Generates business-info.json + auto-context-notes.json for each.
 * Then sends personalized "your website is leaking customers" emails.
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, mkdirSync } from "fs";
import { writeFile, readFile } from "fs/promises";
import { listTenants, getTenant } from "../src/multi-tenant/tenant-registry.js";
import { auditBusinessInfo, businessInfoToNotes } from "../src/multi-tenant/business-audit.js";
import { BGEEmbeddingProvider } from "../src/embeddings/bge-provider.js";
import { QdrantVectorStore } from "../src/embeddings/qdrant-store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_ROOT = resolve(__dirname, "../data");
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const BASE_URL = process.env.BASE_URL || "https://whisp.so";
const FROM = "Jakub <jakub@whisp.so>";
const DRY_RUN = process.argv.includes("--dry-run");
const SEND_EMAILS = process.argv.includes("--send");

async function getChunksFromQdrant(tenantId: string): Promise<{ content: string }[]> {
  const collection = `wctx_${tenantId}`;
  const host = process.env.QDRANT_HOST || "152.53.243.28";
  const port = process.env.QDRANT_PORT || "6333";

  try {
    const resp = await fetch(`http://${host}:${port}/collections/${collection}/points/scroll`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ limit: 100, with_payload: true }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json() as any;
    return (data.result?.points || []).map((p: any) => ({ content: p.payload?.content || "" }));
  } catch {
    return [];
  }
}

function generateInsightEmail(
  domain: string,
  gaps: string[],
  phone: string | null,
  hours: string | null,
  demoUrl: string,
  dashboardUrl: string
): { subject: string; html: string } {
  const gapDescriptions: Record<string, string> = {
    "phone number": "Visitors looking to call you can't find your phone number easily",
    "email address": "There's no clear email contact for inquiries",
    "physical address / location": "Customers trying to visit can't find your address",
    "opening hours / business hours": "People checking when you're open get no answer",
    "pricing / rates": "Visitors want to know your prices before contacting you — but can't find them",
    "booking / appointment system": "There's no clear way to book or make a reservation online",
  };

  const insights = gaps
    .filter(g => gapDescriptions[g])
    .slice(0, 3)
    .map(g => `<li style="padding:6px 0;color:#cbd5e1;font-size:14px;line-height:1.6;">${gapDescriptions[g]}</li>`)
    .join("");

  if (!insights) return { subject: "", html: "" };

  return {
    subject: `${domain} — ${gaps.length} things your visitors can't find`,
    html: `
<div style="font-family:system-ui,sans-serif;background:#0a0e1a;padding:40px 20px;">
  <div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;border:1px solid rgba(255,255,255,0.08);padding:40px;">
    <h2 style="color:#f1f5f9;font-size:20px;margin:0 0 16px;">I analyzed ${domain}</h2>
    <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 20px;">
      I ran an AI audit on your website and found ${gaps.length} thing${gaps.length > 1 ? "s" : ""} your visitors are probably looking for but can't find:
    </p>
    <ul style="list-style:none;padding:0;margin:0 0 24px;">
      ${insights}
    </ul>
    <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">
      I also built an AI assistant that knows your website and can answer visitor questions 24/7. You can try it here:
    </p>
    <a href="${demoUrl}" style="display:inline-block;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none;">See your AI assistant</a>
    <p style="color:#64748b;font-size:13px;margin-top:20px;line-height:1.6;">
      It's free — no signup needed. If you want to add it to your site, it takes one line of code.
    </p>
    <p style="color:#334155;font-size:11px;margin-top:28px;">Jakub — <a href="https://whisp.so" style="color:#475569;">whisp.so</a></p>
  </div>
</div>`,
  };
}

async function main() {
  const tenants = listTenants().filter(t => t.status === "active" && t.chunksCount > 0);
  console.log(`Auditing ${tenants.length} tenants${DRY_RUN ? " (DRY RUN)" : ""}${SEND_EMAILS ? " + sending emails" : ""}`);

  let audited = 0;
  let withGaps = 0;
  let emailed = 0;

  for (const tenant of tenants) {
    const tenantDir = resolve(DATA_ROOT, tenant.id);
    if (!existsSync(tenantDir)) mkdirSync(tenantDir, { recursive: true });

    // Check if already audited
    const bizInfoPath = resolve(tenantDir, "business-info.json");
    if (existsSync(bizInfoPath)) {
      audited++;
      continue;
    }

    // Get chunks from Qdrant
    const chunks = await getChunksFromQdrant(tenant.id);
    if (chunks.length === 0) continue;

    // Run audit
    const bizInfo = auditBusinessInfo(chunks);
    const autoNotes = businessInfoToNotes(bizInfo);

    await writeFile(bizInfoPath, JSON.stringify({
      ...bizInfo,
      autoNotes,
      auditedAt: new Date().toISOString(),
    }, null, 2));

    if (autoNotes.length > 0) {
      await writeFile(resolve(tenantDir, "auto-context-notes.json"), JSON.stringify(autoNotes, null, 2));
    }

    audited++;

    if (bizInfo.gaps.length > 0) {
      withGaps++;

      if (SEND_EMAILS && tenant.email && !DRY_RUN) {
        const tid = tenant.id;
        const demoUrl = `${BASE_URL}/demo/${tid}`;
        const email = generateInsightEmail(
          tenant.domain, bizInfo.gaps, bizInfo.phone, bizInfo.hours, demoUrl, `${BASE_URL}/auth/login`
        );

        if (email.subject) {
          try {
            const resp = await fetch("https://api.resend.com/emails", {
              method: "POST",
              headers: { "Authorization": `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
              body: JSON.stringify({ from: FROM, to: [tenant.email], subject: email.subject, html: email.html, reply_to: "jakub@whisp.so" }),
            });
            if (resp.ok) {
              emailed++;
              console.log(`  ✓ ${tenant.domain}: ${bizInfo.gaps.length} gaps → emailed`);
            }
          } catch {}
          await new Promise(r => setTimeout(r, 1000));
        }
      } else if (DRY_RUN) {
        console.log(`  [DRY] ${tenant.domain}: gaps=${bizInfo.gaps.join(", ")}`);
      }
    }

    if (audited % 20 === 0) {
      console.log(`  Progress: ${audited}/${tenants.length}`);
    }
  }

  console.log(`\nDone: ${audited} audited, ${withGaps} with gaps, ${emailed} emailed`);
}

main().catch(console.error);
