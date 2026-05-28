/**
 * Send follow-up emails to prospects who didn't reply.
 * Reads from pipeline-sent.json, sends a shorter follow-up.
 *
 * Usage:
 *   RESEND_API_KEY=xxx npx tsx scripts/send-followups.ts --dry-run
 *   RESEND_API_KEY=xxx npx tsx scripts/send-followups.ts --send
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || "https://whisp.so";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM = "Jakub <jakub@whisp.so>";
const SEND = process.argv.includes("--send");
const LIMIT = parseInt(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] || "100");

const SENT_LOG_PATH = resolve(__dirname, "../data/pipeline-sent.json");
const FOLLOWUP_LOG_PATH = resolve(__dirname, "../data/followup-sent.json");

let sentLog: Record<string, { sentAt: string; template: string }> = {};
try { sentLog = JSON.parse(readFileSync(SENT_LOG_PATH, "utf-8")); } catch {}

let followupLog: Record<string, { sentAt: string }> = {};
try { followupLog = JSON.parse(readFileSync(FOLLOWUP_LOG_PATH, "utf-8")); } catch {}

async function main() {
  const entries = Object.entries(sentLog)
    .filter(([email, data]) => {
      if (data.template === "skip-broken" || data.template === "skip-hung" || data.template === "skip") return false;
      if (email in followupLog) return false; // already followed up
      // Only follow up after 2+ days
      const sentDate = new Date(data.sentAt);
      const daysSince = (Date.now() - sentDate.getTime()) / (1000 * 60 * 60 * 24);
      return daysSince >= 2;
    })
    .slice(0, LIMIT);

  console.log(`${entries.length} prospects eligible for follow-up${SEND ? "" : " (DRY RUN)"}\n`);

  let sent = 0;
  for (const [email, data] of entries) {
    const domain = email.split("@")[1] || "";
    const tenantId = domain.replace(/[^a-zA-Z0-9]/g, "_");
    const demoUrl = `${BASE_URL}/demo/${tenantId}`;
    const unsub = `<p style="font-size:11px;color:#999;"><a href="${BASE_URL}/unsubscribe?email=${encodeURIComponent(email)}" style="color:#999;">Unsubscribe</a></p>`;

    const subject = `Re: Quick follow-up about ${domain}`;
    const html = `<p>Hi,</p><p>Just following up - did you get a chance to try the AI assistant I built for ${domain}?</p><p><a href="${demoUrl}">${demoUrl}</a></p><p>It's $14.99 one-time to set it up on your site. No subscription. Takes 5 minutes.</p><p>Jakub<br>whisp.so</p>${unsub}`;

    if (!SEND) {
      console.log(`  [DRY] ${email}`);
      sent++;
      continue;
    }

    const unsubUrl = `${BASE_URL}/unsubscribe?email=${encodeURIComponent(email)}`;
    try {
      const resp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM, to: [email], subject, html, reply_to: "jakub@whisp.so",
          headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
        }),
      });
      if (resp.ok) {
        followupLog[email] = { sentAt: new Date().toISOString() };
        writeFileSync(FOLLOWUP_LOG_PATH, JSON.stringify(followupLog, null, 2));
        sent++;
        console.log(`  ✉️  ${email}`);
      } else {
        const err = await resp.text();
        if (err.includes("429") || err.includes("quota")) { console.log("  QUOTA HIT"); break; }
        console.log(`  FAIL: ${err.slice(0, 80)}`);
      }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\nDone: ${sent} follow-ups ${SEND ? "sent" : "would send"}`);
}

main().catch(console.error);
