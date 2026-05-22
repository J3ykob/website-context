/**
 * Validated gap audit — asks each tenant's bot real questions and checks
 * whether responses contain concrete information (not just "check the website").
 *
 * Usage:
 *   npx tsx scripts/validated-audit.ts --dry-run          # just report gaps
 *   npx tsx scripts/validated-audit.ts --send              # report + email owners
 *   npx tsx scripts/validated-audit.ts --limit=20          # only audit 20 tenants
 *   npx tsx scripts/validated-audit.ts --tenant=some_id    # audit one tenant
 */

const BASE_URL = process.env.BASE_URL || "https://whisp.so";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM = "Jakub <jakub@whisp.so>";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "whisp-admin-2026";
const SEND = process.argv.includes("--send");
const DRY_RUN = process.argv.includes("--dry-run") || !SEND;
const LIMIT = parseInt(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] || "999");
const SINGLE = process.argv.find(a => a.startsWith("--tenant="))?.split("=")[1];

interface Question {
  key: string;
  label: string;
  question: string;
  validate: (answer: string) => boolean;
}

const QUESTIONS: Question[] = [
  {
    key: "phone",
    label: "phone number",
    question: "What is your phone number?",
    validate: (a) => /\+?\d[\d\s()-]{6,}/.test(a),
  },
  {
    key: "hours",
    label: "opening hours",
    question: "What are your opening hours?",
    validate: (a) => /\d{1,2}[:.]\d{2}/.test(a) || /\d{1,2}\s*(am|pm|AM|PM)/.test(a),
  },
  {
    key: "address",
    label: "address / location",
    question: "What is your address?",
    validate: (a) =>
      /(ul\.|ulica|street|str\.|aleja|al\.|plac|avenue|road|blvd)/i.test(a) ||
      /\d{2}-\d{3}/.test(a) ||
      /\d+\s+\w+\s+(st|ave|rd|blvd|street|road)/i.test(a),
  },
  {
    key: "pricing",
    label: "pricing",
    question: "What are your prices?",
    validate: (a) =>
      /\d+[.,]?\d*\s*(zł|PLN|€|EUR|\$|USD|£|GBP)/i.test(a) ||
      /(?:from|od|starting)\s*\d/i.test(a),
  },
  {
    key: "booking",
    label: "booking / reservations",
    question: "How can I book or make a reservation?",
    validate: (a) =>
      /\+?\d[\d\s()-]{6,}/.test(a) ||
      /https?:\/\//.test(a) ||
      /(?:email|call|phone|zadzwoń|napisz|formularz|form)/i.test(a),
  },
];

async function askBot(tenantId: string, question: string): Promise<string> {
  const sessionId = `audit-${Date.now()}`;
  const resp = await fetch(`${BASE_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tenantId,
      sessionId,
      messages: [{ role: "user", content: question }],
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) return "";
  const data = (await resp.json()) as { message?: string };
  return data.message || "";
}

async function auditTenant(tenantId: string): Promise<{ gaps: string[]; results: Record<string, { answer: string; concrete: boolean }> }> {
  const results: Record<string, { answer: string; concrete: boolean }> = {};
  const gaps: string[] = [];

  for (const q of QUESTIONS) {
    try {
      const answer = await askBot(tenantId, q.question);
      const concrete = answer.length > 10 && q.validate(answer);
      results[q.key] = { answer: answer.slice(0, 150), concrete };
      if (!concrete) gaps.push(q.label);
    } catch {
      results[q.key] = { answer: "(timeout)", concrete: false };
      gaps.push(q.label);
    }
  }

  return { gaps, results };
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
  "phone number": "Visitors looking to call you can't find your phone number easily",
  "opening hours": "People checking when you're open get no answer",
  "address / location": "Customers trying to visit can't find your address",
  "pricing": "Visitors want to know your prices before contacting you — but can't find them",
  "booking / reservations": "There's no clear way to book or make a reservation online",
};

async function sendGapEmail(email: string, domain: string, gaps: string[], demoUrl: string): Promise<boolean> {
  const insights = gaps
    .filter(g => gapDescriptions[g])
    .slice(0, 3)
    .map(g => `<li style="padding:6px 0;color:#cbd5e1;font-size:14px;line-height:1.6;">${gapDescriptions[g]}</li>`)
    .join("");

  if (!insights) return false;

  const resp = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: FROM,
      to: [email],
      subject: `${domain} — ${gaps.length} things your visitors can't find`,
      html: `<div style="font-family:system-ui,sans-serif;background:#0a0e1a;padding:40px 20px;">
  <div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;border:1px solid rgba(255,255,255,0.08);padding:40px;">
    <h2 style="color:#f1f5f9;font-size:20px;margin:0 0 16px;">I analyzed ${domain}</h2>
    <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 20px;">
      I ran an AI audit on your website and found ${gaps.length} thing${gaps.length > 1 ? "s" : ""} visitors are probably looking for but can't find:
    </p>
    <ul style="list-style:none;padding:0;margin:0 0 24px;">${insights}</ul>
    <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">
      I also built an AI assistant that knows your website and answers visitor questions 24/7:
    </p>
    <a href="${demoUrl}" style="display:inline-block;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none;">See your AI assistant</a>
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
  let tenants: { id: string; domain: string; email?: string; chunksCount: number }[];

  const allTenants = await getTenants();
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

  for (const tenant of tenants) {
    total++;
    const { gaps, results } = await auditTenant(tenant.id);

    const statusLine = QUESTIONS.map(q => {
      const r = results[q.key];
      return r?.concrete ? `  ✅ ${q.label}` : `  ❌ ${q.label}`;
    }).join("\n");

    console.log(`=== ${tenant.domain} (${tenant.id}) ===`);
    console.log(statusLine);

    if (gaps.length > 0) {
      withGaps++;
      console.log(`  → ${gaps.length} gap(s): ${gaps.join(", ")}`);

      if (SEND && tenant.email) {
        const demoUrl = `${BASE_URL}/demo/${tenant.id}`;
        const sent = await sendGapEmail(tenant.email, tenant.domain, gaps, demoUrl);
        if (sent) {
          emailed++;
          console.log(`  → ✉️  Emailed ${tenant.email}`);
        }
        await new Promise(r => setTimeout(r, 500));
      }
    } else {
      console.log(`  → Clean — all info found`);
    }
    console.log();

    if (total % 10 === 0) console.log(`--- Progress: ${total}/${tenants.length} ---\n`);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Total: ${total} | With gaps: ${withGaps} | Emailed: ${emailed}`);
}

main().catch(console.error);
