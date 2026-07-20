/**
 * Onboard new prospects: register → scrape → verify → email
 * Reads domains from prospect-domains.txt, registers each on Whisp,
 * waits for scraping, then sends A/B/C emails in the right language.
 *
 * Usage:
 *   RESEND_API_KEY=re_xxx npx tsx scripts/onboard-and-email.ts --dry-run
 *   RESEND_API_KEY=re_xxx npx tsx scripts/onboard-and-email.ts --send
 *   RESEND_API_KEY=re_xxx npx tsx scripts/onboard-and-email.ts --register-only
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || "https://whisp.so";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const FROM = "Jakub <jakub@whisp.so>";
const SEND = process.argv.includes("--send");
const REGISTER_ONLY = process.argv.includes("--register-only");

interface Prospect { domain: string; lang: "pl" | "en" }

function loadProspects(): Prospect[] {
  const text = readFileSync(resolve(__dirname, "prospect-domains.txt"), "utf-8");
  const prospects: Prospect[] = [];
  let lang: "pl" | "en" = "en";
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "=== POLISH ===") { lang = "pl"; continue; }
    if (trimmed === "=== EUROPEAN ===") { lang = "en"; continue; }
    if (!trimmed || trimmed.startsWith("#")) continue;
    prospects.push({ domain: trimmed, lang });
  }
  return prospects;
}

async function registerTenant(domain: string): Promise<{ id: string; email: string } | null> {
  try {
    const resp = await fetch(`${BASE_URL}/api/tenants?secret=${ADMIN_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteUrl: `https://${domain}`, email: `info@${domain}` }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      const err = await resp.text();
      if (err.includes("already exists")) {
        const data = JSON.parse(err.includes("{") ? err.slice(err.indexOf("{")) : "{}");
        const tenantId = data.tenantId || domain.replace(/[^a-zA-Z0-9]/g, "_");
        return { id: tenantId, email: `info@${domain}` };
      }
      return null;
    }
    const data = (await resp.json()) as any;
    return { id: data.tenantId, email: `info@${domain}` };
  } catch {
    return null;
  }
}

async function checkReady(tenantId: string): Promise<boolean> {
  try {
    const resp = await fetch(`${BASE_URL}/api/admin/tenants?secret=${ADMIN_SECRET}`);
    const tenants = (await resp.json()) as any[];
    const t = tenants.find((x: any) => x.id === tenantId);
    return t && t.status === "active" && t.chunksCount > 0;
  } catch {
    return false;
  }
}

function getEmail(domain: string, lang: "pl" | "en", demoUrl: string, template: string, contactEmail: string) {
  const unsubUrl = `${BASE_URL}/unsubscribe?email=${encodeURIComponent(contactEmail)}`;
  const sig = `<p>Jakub<br>whisp.so</p>`;
  const unsub = `<p style="font-size:11px;color:#999;"><a href="${unsubUrl}" style="color:#999;">Unsubscribe</a></p>`;
  const cta = lang === "pl"
    ? `<p>Moge to uruchomić na Twojej stronie do jutra - wystarczy odpowiedzieć na tego maila lub <a href="https://cal.com/whisp/15min">umówić się na rozmowę</a>.</p>`
    : `<p>I can have this running on your site by tomorrow - you can reply here or <a href="https://cal.com/whisp/15min">book a call</a> with me to discuss it in details.</p>`;

  if (template === "clean") {
    return {
      subject: lang === "pl"
        ? `Zbudowałem darmowego asystenta AI dla ${domain}`
        : `I built a free AI assistant for ${domain}`,
      html: lang === "pl"
        ? `<p>Cześć,</p><p>Zbudowałem asystenta AI, który czyta ${domain} i odpowiada na pytania odwiedzających - usługi, cennik, lokalizacja, godziny otwarcia, wszystko co jest na stronie.</p><p>Już zna Twoją stronę. Możesz go wypróbować tutaj:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`
        : `<p>Hi,</p><p>I built an AI assistant that reads ${domain} and answers visitor questions - pricing, services, location, hours, anything on your site.</p><p>It already knows your website. You can try it here:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    };
  } else if (template === "gaps") {
    return {
      subject: lang === "pl"
        ? `Przetestowałem ${domain} z perspektywy klienta`
        : `I tested ${domain} from a customer's perspective`,
      html: lang === "pl"
        ? `<p>Cześć,</p><p>Zbudowałem AI, który czyta Twoją stronę i odpowiada na pytania odwiedzających. Przetestowałem go na ${domain} - większość odpowiedzi była dobra, ale kilka typowych pytań zostawiło odwiedzających bez jasnej odpowiedzi.</p><p>Zobacz co wie i czego mu brakuje:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`
        : `<p>Hi,</p><p>I built an AI that reads your website and answers visitor questions. I tested it on ${domain} - most questions got good answers, but a few common ones left visitors without a clear next step.</p><p>You can see exactly what it knows and what's missing:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    };
  } else {
    return {
      subject: lang === "pl"
        ? `Mogę pomóc ${domain} z AI?`
        : `Can I help ${domain} with AI?`,
      html: lang === "pl"
        ? `<p>Cześć,</p><p>Jestem Jakub, studiuję informatykę w Polsce i pomagam firmom wdrażać AI żeby rosły. Zbudowałem asystenta AI, który czyta Twoją stronę i odpowiada na pytania klientów 24/7.</p><p>Już zrobiłem jednego dla ${domain} - zna Twoje usługi, cennik i wszystko co jest na stronie:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`
        : `<p>Hi,</p><p>I'm Jakub, I study Computer Science in Poland and I'm helping businesses onboard AI to grow. I built an AI assistant that reads your website and can answer customer questions 24/7.</p><p>I already made one for ${domain} - it knows your services, pricing, and everything on your site:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    };
  }
}

async function main() {
  const prospects = loadProspects();
  console.log(`Loaded ${prospects.length} prospects\n`);

  const templates = ["clean", "gaps", "personal"];
  let registered = 0, ready = 0, emailed = 0, failed = 0;

  // Step 1: Register all
  console.log("=== REGISTERING ===");
  const registered_list: { prospect: Prospect; id: string; email: string }[] = [];

  for (const p of prospects) {
    const result = await registerTenant(p.domain);
    if (result) {
      registered++;
      registered_list.push({ prospect: p, ...result });
      console.log(`  ✓ ${p.domain}`);
    } else {
      failed++;
      console.log(`  ✗ ${p.domain}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nRegistered: ${registered} | Failed: ${failed}`);

  if (REGISTER_ONLY) {
    console.log("Register-only mode, stopping here.");
    return;
  }

  // Step 2: Wait for scraping (check every 30s for up to 10 min)
  console.log("\n=== WAITING FOR SCRAPING ===");
  const maxWait = 10 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    let readyCount = 0;
    for (const r of registered_list) {
      if (await checkReady(r.id)) readyCount++;
    }
    console.log(`  ${readyCount}/${registered_list.length} ready (${Math.round((Date.now() - start) / 1000)}s)`);
    if (readyCount >= registered_list.length * 0.7) break;
    await new Promise(r => setTimeout(r, 30000));
  }

  // Step 3: Send emails
  console.log("\n=== SENDING EMAILS ===");

  // Fetch unsub list
  let unsubs: string[] = [];
  try {
    const unsubResp = await fetch(`${BASE_URL}/api/admin/unsubscribed?secret=${ADMIN_SECRET}`);
    if (unsubResp.ok) unsubs = (await unsubResp.json()) as string[];
  } catch {}
  const unsubSet = new Set(unsubs.map(e => e.toLowerCase()));

  // Get actual tenant data
  const tenantsResp = await fetch(`${BASE_URL}/api/admin/tenants?secret=${ADMIN_SECRET}`);
  const allTenants = (await tenantsResp.json()) as any[];
  const tenantMap = new Map(allTenants.map((t: any) => [t.id, t]));

  for (let i = 0; i < registered_list.length; i++) {
    const { prospect, id } = registered_list[i];
    const tenant = tenantMap.get(id);

    if (!tenant || tenant.status !== "active" || tenant.chunksCount === 0) {
      console.log(`  SKIP ${prospect.domain} (not ready)`);
      continue;
    }

    const email = tenant.email || `info@${prospect.domain}`;
    if (unsubSet.has(email.toLowerCase())) {
      console.log(`  UNSUB ${prospect.domain}`);
      continue;
    }

    const template = templates[i % 3];
    const demoUrl = `${BASE_URL}/demo/${id}`;
    const { subject, html } = getEmail(prospect.domain, prospect.lang, demoUrl, template, email);

    if (!SEND) {
      console.log(`  [DRY] [${template}] [${prospect.lang}] ${prospect.domain} → ${email}`);
      emailed++;
      continue;
    }

    const unsubUrl = `${BASE_URL}/unsubscribe?email=${encodeURIComponent(email)}`;
    try {
      const emailResp = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: FROM, to: [email], subject, html,
          reply_to: "jakub@whisp.so",
          headers: {
            "List-Unsubscribe": `<${unsubUrl}>`,
            "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          },
        }),
      });
      if (emailResp.ok) {
        emailed++;
        console.log(`  ✉️  [${template}] [${prospect.lang}] ${prospect.domain} → ${email}`);
      } else {
        const err = await emailResp.text();
        if (err.includes("429") || err.includes("quota")) {
          console.log(`  QUOTA HIT — stopping. ${emailed} sent so far.`);
          break;
        }
        console.log(`  FAIL ${prospect.domain}: ${err.slice(0, 80)}`);
      }
    } catch (e) {
      console.log(`  ERR ${prospect.domain}: ${e}`);
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n=== DONE === Registered: ${registered} | Emailed: ${emailed}`);
}

main().catch(console.error);
