/**
 * Validated gap audit — asks each tenant's bot natural visitor questions
 * and checks whether responses contain real, concrete information vs
 * deflections like "check the website" or "contact us for details".
 *
 * Usage:
 *   npx tsx scripts/validated-audit.ts --dry-run          # just report gaps
 *   npx tsx scripts/validated-audit.ts --send              # report + email owners
 *   npx tsx scripts/validated-audit.ts --limit=20          # only audit 20 tenants
 *   npx tsx scripts/validated-audit.ts --tenant=some_id    # audit one tenant
 */

const BASE_URL = process.env.BASE_URL || "https://whisp.so";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM = "Jakub <jakub@whisp.so>";
const SEND = process.argv.includes("--send");
const DRY_RUN = process.argv.includes("--dry-run") || !SEND;
const LIMIT = parseInt(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] || "999");
const SINGLE = process.argv.find(a => a.startsWith("--tenant="))?.split("=")[1];

interface Question {
  key: string;
  label: string;
  question: string;
  hasConcrete: (answer: string) => boolean;
  isDeflection: (answer: string) => boolean;
}

const DEFLECTION_PATTERNS = [
  /check (?:the|their|our) (?:website|site|page)/i,
  /visit (?:the|their|our) (?:website|site|page)/i,
  /(?:for (?:the )?most (?:accurate|up.to.date)|contact (?:them|us) (?:directly|for))/i,
  /(?:I (?:don't|do not) have|not (?:available|provided|mentioned|specified|included))/i,
  /(?:couldn't find|no (?:specific|detailed) (?:info|information))/i,
  /recommend (?:checking|visiting|contacting)/i,
];

function isGenericDeflection(answer: string): boolean {
  return DEFLECTION_PATTERNS.some(p => p.test(answer));
}

const QUESTIONS: Question[] = [
  {
    key: "contact",
    label: "contact info",
    question: "How can I get in touch with you?",
    hasConcrete: (a) =>
      // Phone: digits with separators
      /(?:\+?\d[\d\s().-]{6,})/.test(a) ||
      // Email: actual address
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(a),
    isDeflection: isGenericDeflection,
  },
  {
    key: "location",
    label: "location",
    question: "I'd like to visit — where exactly are you?",
    hasConcrete: (a) =>
      // Street/road patterns (international)
      /(ul\.|ulica|street|str\.|aleja|al\.|plac|avenue|road|blvd|lane|drive|way|rue|via|calle|straße|straat|gatan)/i.test(a) ||
      // Postal codes (various formats)
      /\d{2,5}[-\s]?\d{2,5}/.test(a) ||
      // City + country or region
      /(?:in|located|situated)\s+(?:in\s+)?[A-Z][a-zà-ÿ]+(?:[-\s][A-Z][a-zà-ÿ]+){0,3},?\s+[A-Z]/i.test(a) ||
      // Specific place names with numbers (addresses)
      /\d+\s+[A-ZÀ-Ÿ][a-zà-ÿ]+/.test(a),
    isDeflection: isGenericDeflection,
  },
  {
    key: "offering",
    label: "main offering",
    question: "What exactly do you offer? Give me the short version.",
    hasConcrete: (a) => a.length > 100,
    isDeflection: (a) => a.length < 100 && isGenericDeflection(a),
  },
  {
    key: "differentiation",
    label: "why choose them",
    question: "What makes you different from others in your space?",
    hasConcrete: (a) => a.length > 100,
    isDeflection: (a) => a.length < 100 && isGenericDeflection(a),
  },
  {
    key: "next_step",
    label: "next step / CTA",
    question: "I'm interested — what should I do next?",
    hasConcrete: (a) =>
      // Should contain a URL, phone, email, or specific action
      /https?:\/\//.test(a) ||
      /(?:\+?\d[\d\s().-]{6,})/.test(a) ||
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/.test(a) ||
      // Or a clear action verb
      /(book|reserve|call|email|fill|submit|schedule|sign up|register|apply|order|request)/i.test(a),
    isDeflection: isGenericDeflection,
  },
];

async function askBot(tenantId: string, question: string): Promise<string> {
  const sessionId = `audit-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  try {
    const resp = await fetch(`${BASE_URL}/api/chat`, {
      method: "POST",
      // X-Whisp-Probe marks this as internal audit traffic so it never pollutes
      // prospect analytics (chat_start / sessions / messages) — see the serve isProbe gate.
      headers: { "Content-Type": "application/json", "X-Whisp-Probe": "1" },
      body: JSON.stringify({
        tenantId,
        sessionId,
        messages: [{ role: "user", content: question }],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!resp.ok) return "";
    const data = (await resp.json()) as { message?: string };
    return data.message || "";
  } catch {
    return "";
  }
}

type Verdict = "concrete" | "deflection" | "empty";

async function auditTenant(tenantId: string): Promise<{
  verdicts: Record<string, { verdict: Verdict; snippet: string }>;
  gaps: string[];
  strengths: string[];
}> {
  const verdicts: Record<string, { verdict: Verdict; snippet: string }> = {};
  const gaps: string[] = [];
  const strengths: string[] = [];

  for (const q of QUESTIONS) {
    const answer = await askBot(tenantId, q.question);
    let verdict: Verdict;

    if (answer.length < 15) {
      verdict = "empty";
    } else if (q.isDeflection(answer) && !q.hasConcrete(answer)) {
      verdict = "deflection";
    } else if (q.hasConcrete(answer)) {
      verdict = "concrete";
    } else {
      verdict = "deflection";
    }

    verdicts[q.key] = { verdict, snippet: answer.slice(0, 120).replace(/\n/g, " ") };

    if (verdict === "concrete") {
      strengths.push(q.label);
    } else {
      gaps.push(q.label);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  return { verdicts, gaps, strengths };
}

async function getTenants(): Promise<{ id: string; domain: string; email?: string; chunksCount: number }[]> {
  const resp = await fetch(`${BASE_URL}/api/admin/tenants?secret=${ADMIN_SECRET}`);
  if (!resp.ok) throw new Error(`Can't fetch tenants: ${resp.status}`);
  const tenants = (await resp.json()) as any[];
  return tenants
    .filter((t: any) => t.status === "active" && t.chunksCount > 0)
    .map((t: any) => ({ id: t.id, domain: t.domain, email: t.email, chunksCount: t.chunksCount }));
}

const gapDescriptions: Record<string, string> = {
  "contact info": "Visitors asking how to reach you get a vague answer — no phone or email surfaced",
  "location": "People trying to find you can't get a clear address",
  "main offering": "The bot can't clearly explain what you do or what services you offer",
  "why choose them": "When asked why to choose you, the bot has nothing specific to say",
  "next step / CTA": "Interested visitors don't get a clear next step — no link, phone, or booking action",
};

async function sendGapEmail(email: string, domain: string, gaps: string[], strengths: string[], demoUrl: string): Promise<boolean> {
  const insights = gaps
    .filter(g => gapDescriptions[g])
    .slice(0, 3)
    .map(g => `<li style="padding:6px 0;color:#cbd5e1;font-size:14px;line-height:1.6;">⚠️ ${gapDescriptions[g]}</li>`)
    .join("");

  if (!insights) return false;

  const strengthList = strengths.length > 0
    ? `<p style="color:#94a3b8;font-size:13px;margin:0 0 20px;">What's working well: <span style="color:#10b981;">${strengths.join(", ")}</span></p>`
    : "";

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject: `I tested ${domain} from a customer's perspective`,
      html: `<div style="font-family:system-ui,sans-serif;background:#0a0e1a;padding:40px 20px;">
  <div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;border:1px solid rgba(255,255,255,0.08);padding:40px;">
    <h2 style="color:#f1f5f9;font-size:20px;margin:0 0 16px;">I pretended to be a customer on ${domain}</h2>
    <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 20px;">
      I built an AI assistant that reads your website and answers visitor questions. Then I tested it with the kinds of questions real customers ask. Here's what I found:
    </p>
    ${strengthList}
    <p style="color:#94a3b8;font-size:14px;margin:0 0 12px;">Where visitors might get stuck:</p>
    <ul style="list-style:none;padding:0;margin:0 0 24px;">${insights}</ul>
    <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">
      You can try the assistant yourself — it already knows your website:
    </p>
    <a href="${demoUrl}" style="display:inline-block;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none;">Try your AI assistant</a>
    <p style="color:#64748b;font-size:13px;margin-top:20px;">Free — no signup needed. One line of code to add to your site.</p>
    <p style="color:#334155;font-size:11px;margin-top:28px;">Jakub — <a href="https://whisp.so" style="color:#475569;">whisp.so</a></p>
  </div>
</div>`,
      reply_to: "jakub@whisp.so",
    }),
  });
  return resp.ok;
}

async function main() {
  const allTenants = await getTenants();
  let tenants: typeof allTenants;

  if (SINGLE) {
    const t = allTenants.find(t => t.id === SINGLE);
    if (!t) { console.error(`Tenant ${SINGLE} not found`); process.exit(1); }
    tenants = [t];
  } else {
    tenants = allTenants;
  }

  tenants = tenants.slice(0, LIMIT);
  console.log(`Validated audit: ${tenants.length} tenants${DRY_RUN ? " (DRY RUN)" : ""}${SEND ? " + sending emails" : ""}\n`);

  let total = 0, withGaps = 0, emailed = 0;
  const ICON = { concrete: "✅", deflection: "🔶", empty: "❌" };

  for (const tenant of tenants) {
    total++;
    const { verdicts, gaps, strengths } = await auditTenant(tenant.id);

    console.log(`=== ${tenant.domain} (${tenant.id}) ===`);
    for (const q of QUESTIONS) {
      const v = verdicts[q.key];
      console.log(`  ${ICON[v.verdict]} ${q.label}: ${v.snippet}`);
    }

    if (gaps.length > 0) {
      withGaps++;
      console.log(`  → ${gaps.length} gap(s): ${gaps.join(", ")}`);

      if (SEND && tenant.email) {
        const demoUrl = `${BASE_URL}/demo/${tenant.id}`;
        const sent = await sendGapEmail(tenant.email, tenant.domain, gaps, strengths, demoUrl);
        if (sent) {
          emailed++;
          console.log(`  → ✉️  Emailed ${tenant.email}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    } else {
      console.log(`  → Clean — all questions answered well`);
    }
    console.log();

    if (total % 10 === 0) console.log(`--- Progress: ${total}/${tenants.length} ---\n`);

    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total: ${total} | With gaps: ${withGaps} | Emailed: ${emailed}`);
}

main().catch(console.error);
