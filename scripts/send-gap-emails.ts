/**
 * Send gap insight emails to pre-identified tenants with contact info gaps.
 * Uses the admin API to get tenant emails, sends via Resend.
 *
 * Usage:
 *   RESEND_API_KEY=re_xxx npx tsx scripts/send-gap-emails.ts --dry-run
 *   RESEND_API_KEY=re_xxx npx tsx scripts/send-gap-emails.ts --send
 */

const BASE_URL = process.env.BASE_URL || "https://whisp.so";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM = "Jakub <jakub@whisp.so>";
const DRY_RUN = !process.argv.includes("--send");

const TARGETS = [
  "jmc-legal_com","zuiveramsterdam_nl","savoyhotelspa_it","ideahotel_it",
  "amrathkurhaus_com","fairlawns_co_uk","careerlegal_com","villalacoste_com",
  "grandhotelvictoria_it","palace_de","chaismonnethotel_com","amrathamsterdam_com",
  "blocomestre_pt","seezeitlodge-bostalsee_de","hotelalex_fr","baiaverde_it",
  "executivespahotel_com","grandhotelbristol_it","hotelsaintebarbe_com","ecolegal_pl",
  "termedia_pl","psew_pl","lancesoft_eu","fanutrition_pl","konsal_pl",
  "primrose_edu_pl","galerianieruchomosci_pl","pracowniatattoo_pl","ecokids_edu_pl",
  "solidnaksiegowa_com","strefaserwisowa_waw_pl","detailingownia_pl","deepcut_pl",
  "neodom_pl","metropolia_nieruchomosci_pl","efektywny_com","floristica_pl",
  "1909fryzjerzy_pl","mazfryzjerki_com","okopowa53_pl",
];

async function main() {
  const resp = await fetch(`${BASE_URL}/api/admin/tenants?secret=${ADMIN_SECRET}`);
  const allTenants = (await resp.json()) as any[];
  const tenantMap = new Map(allTenants.map(t => [t.id, t]));

  console.log(`Sending gap emails to ${TARGETS.length} tenants${DRY_RUN ? " (DRY RUN)" : ""}\n`);

  let sent = 0, skipped = 0;

  for (const id of TARGETS) {
    const tenant = tenantMap.get(id);
    if (!tenant || !tenant.email || !tenant.email.includes("@") || tenant.email.includes("x0poTQTo7")) {
      console.log(`  SKIP ${id} — no valid email`);
      skipped++;
      continue;
    }

    const domain = tenant.domain;
    const demoUrl = `${BASE_URL}/demo/${id}`;

    const subject = `I tested ${domain} from a customer's perspective`;
    const html = `<div style="font-family:system-ui,sans-serif;background:#0a0e1a;padding:40px 20px;">
  <div style="max-width:520px;margin:0 auto;background:#111827;border-radius:16px;border:1px solid rgba(255,255,255,0.08);padding:40px;">
    <h2 style="color:#f1f5f9;font-size:20px;margin:0 0 16px;">I pretended to be a customer on ${domain}</h2>
    <p style="color:#94a3b8;font-size:15px;line-height:1.6;margin:0 0 20px;">
      I built an AI assistant that reads your entire website and answers visitor questions. Then I tested it with real customer queries. Here's what I found:
    </p>
    <p style="color:#10b981;font-size:14px;margin:0 0 8px;">What's working well:</p>
    <p style="color:#cbd5e1;font-size:14px;margin:0 0 20px;">Your website content covers your offering, location, and next steps clearly.</p>
    <p style="color:#f59e0b;font-size:14px;margin:0 0 8px;">Where visitors get stuck:</p>
    <ul style="list-style:none;padding:0;margin:0 0 24px;">
      <li style="padding:6px 0;color:#cbd5e1;font-size:14px;line-height:1.6;">⚠️ When visitors ask how to contact you, they don't get a phone number or email — just "check the website"</li>
    </ul>
    <p style="color:#94a3b8;font-size:14px;line-height:1.6;margin:0 0 24px;">
      You can try the assistant yourself — it already knows your website:
    </p>
    <a href="${demoUrl}" style="display:inline-block;background:#3b82f6;color:#fff;font-size:14px;font-weight:600;padding:12px 24px;border-radius:10px;text-decoration:none;">Try your AI assistant</a>
    <p style="color:#64748b;font-size:13px;margin-top:20px;">Free — no signup needed. One line of code to add to your site.</p>
    <p style="color:#334155;font-size:11px;margin-top:28px;">Jakub — <a href="https://whisp.so" style="color:#475569;">whisp.so</a></p>
    <p style="color:#1e293b;font-size:10px;margin-top:16px;"><a href="${BASE_URL}/unsubscribe?email=${encodeURIComponent(tenant.email)}" style="color:#334155;">Unsubscribe</a></p>
  </div>
</div>`;

    if (DRY_RUN) {
      console.log(`  [DRY] ${domain} → ${tenant.email}`);
      sent++;
      continue;
    }

    // Check unsubscribe list
    try {
      const unsubResp = await fetch(`${BASE_URL}/api/admin/unsubscribed?secret=${ADMIN_SECRET}`);
      if (unsubResp.ok) {
        const unsubs = (await unsubResp.json()) as string[];
        if (unsubs.includes(tenant.email.toLowerCase())) {
          console.log(`  UNSUB ${domain} — ${tenant.email}`);
          skipped++;
          continue;
        }
      }
    } catch {}

    const unsubUrl = `${BASE_URL}/unsubscribe?email=${encodeURIComponent(tenant.email)}`;
    try {
      const emailResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM,
          to: [tenant.email],
          subject,
          html,
          reply_to: "jakub@whisp.so",
          headers: {
            "List-Unsubscribe": `<${unsubUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }),
      });
      if (emailResp.ok) {
        sent++;
        console.log(`  ✉️  ${domain} → ${tenant.email}`);
      } else {
        const err = await emailResp.text();
        console.log(`  FAIL ${domain}: ${err.slice(0, 100)}`);
        skipped++;
      }
    } catch (e) {
      console.log(`  ERR ${domain}: ${e}`);
      skipped++;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n=== DONE === Sent: ${sent} | Skipped: ${skipped}`);
}

main().catch(console.error);
