/**
 * Apollo → Whisp pipeline: find prospects, enrich, register, send.
 *
 * Searches Apollo for business owners/directors by industry + country,
 * enriches contacts to get verified emails + domains, registers on Whisp,
 * waits for scraping, then sends A/B/C emails.
 *
 * Usage:
 *   npx tsx scripts/apollo-pipeline.ts --industry=hotel --country=Poland --limit=30 --dry-run
 *   RESEND_API_KEY=re_xxx npx tsx scripts/apollo-pipeline.ts --industry=restaurant --country=Netherlands --limit=50 --send
 *   npx tsx scripts/apollo-pipeline.ts --industry=dental --country="United Kingdom" --limit=100 --send
 *
 * Industries: hotel, restaurant, law, realestate, salon, dental, fitness, auto, education, wedding, tattoo
 */

const BASE_URL = process.env.BASE_URL || "https://whisp.so";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "whisp-admin-2026";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const APOLLO_KEY = process.env.APOLLO_API_KEY || "pE5gk8pup_3dk6a55bpFSg";
const FROM = "Jakub <jakub@whisp.so>";
const SEND = process.argv.includes("--send");
const LIMIT = parseInt(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] || "30");
const INDUSTRY = process.argv.find(a => a.startsWith("--industry="))?.split("=")[1] || "hotel";
const COUNTRY = process.argv.find(a => a.startsWith("--country="))?.split("=")[1] || "Poland";

const INDUSTRY_KEYWORDS: Record<string, string[]> = {
  hotel: ["hotel", "boutique hotel", "bed and breakfast", "guesthouse"],
  restaurant: ["restaurant", "cafe", "bistro", "dining"],
  law: ["law firm", "legal services", "solicitors", "kancelaria"],
  realestate: ["real estate", "property", "nieruchomości", "makelaardij"],
  salon: ["hair salon", "barbershop", "beauty salon", "fryzjer"],
  dental: ["dental", "dentist", "stomatologia", "tandarts"],
  fitness: ["gym", "fitness", "crossfit", "yoga studio"],
  auto: ["auto repair", "car service", "garage", "warsztat"],
  education: ["school", "language school", "education", "szkoła"],
  wedding: ["wedding venue", "event venue", "sala weselna"],
  tattoo: ["tattoo studio", "tattoo", "piercing"],
};

const PL_COUNTRIES = ["Poland"];
function isPolish(country: string): boolean {
  return PL_COUNTRIES.some(c => country.toLowerCase().includes(c.toLowerCase()));
}

interface Prospect {
  apolloId: string;
  firstName: string;
  email: string;
  domain: string;
  orgName: string;
  title: string;
  country: string;
  lang: "pl" | "en";
}

async function searchApollo(keywords: string[], country: string, page: number): Promise<any> {
  const resp = await fetch("https://api.apollo.io/api/v1/mixed_people/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    body: JSON.stringify({
      q_organization_keyword_tags: keywords,
      organization_locations: [country],
      organization_num_employees_ranges: ["1,50"],
      person_seniorities: ["owner", "founder", "c_suite", "director"],
      contact_email_status: ["verified"],
      page,
      per_page: 25,
    }),
  });
  return resp.json();
}

async function enrichPerson(id: string): Promise<any> {
  const resp = await fetch("https://api.apollo.io/api/v1/people/match", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    body: JSON.stringify({ id }),
  });
  return resp.json();
}

async function registerTenant(domain: string): Promise<string | null> {
  try {
    const resp = await fetch(`${BASE_URL}/api/tenants?secret=${ADMIN_SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ siteUrl: `https://${domain}`, email: `info@${domain}` }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await resp.json() as any;
    if (data.tenantId) return data.tenantId;
    if (data.error?.includes("already exists")) return data.tenantId || domain.replace(/[^a-zA-Z0-9]/g, "_");
    return null;
  } catch { return null; }
}

function getEmailHtml(p: Prospect, demoUrl: string, template: string): { subject: string; html: string } {
  const unsub = `<p style="font-size:11px;color:#999;"><a href="${BASE_URL}/unsubscribe?email=${encodeURIComponent(p.email)}" style="color:#999;">${p.lang === "pl" ? "Wypisz się" : "Unsubscribe"}</a></p>`;
  const sig = `<p>Jakub<br>whisp.so</p>`;
  const cta = p.lang === "pl"
    ? `<p>Mogę to uruchomić na Twojej stronie do jutra - wystarczy odpowiedzieć na tego maila lub <a href="https://cal.com/whisp/15min">umówić się na rozmowę</a>.</p>`
    : `<p>I can have this running on your site by tomorrow - you can reply here or <a href="https://cal.com/whisp/15min">book a call</a> with me to discuss it in details.</p>`;
  const hi = p.lang === "pl" ? `Cześć ${p.firstName},` : `Hi ${p.firstName},`;

  if (template === "clean") {
    return {
      subject: p.lang === "pl" ? `Zbudowałem darmowego asystenta AI dla ${p.domain}` : `I built a free AI assistant for ${p.domain}`,
      html: p.lang === "pl"
        ? `<p>${hi}</p><p>Zbudowałem asystenta AI, który czyta ${p.domain} i odpowiada na pytania odwiedzających - usługi, cennik, lokalizacja, godziny otwarcia, wszystko co jest na stronie.</p><p>Już zna Twoją stronę. Możesz go wypróbować tutaj:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`
        : `<p>${hi}</p><p>I built an AI assistant that reads ${p.domain} and answers visitor questions - pricing, services, location, hours, anything on your site.</p><p>It already knows your website. You can try it here:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    };
  } else if (template === "gaps") {
    return {
      subject: p.lang === "pl" ? `Przetestowałem ${p.domain} z perspektywy klienta` : `I tested ${p.domain} from a customer's perspective`,
      html: p.lang === "pl"
        ? `<p>${hi}</p><p>Zbudowałem AI, który czyta Twoją stronę i odpowiada na pytania odwiedzających. Przetestowałem go na ${p.domain} - większość odpowiedzi była dobra, ale kilka typowych pytań zostawiło odwiedzających bez jasnej odpowiedzi.</p><p>Zobacz co wie i czego mu brakuje:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`
        : `<p>${hi}</p><p>I built an AI that reads your website and answers visitor questions. I tested it on ${p.domain} - most questions got good answers, but a few common ones left visitors without a clear next step.</p><p>You can see exactly what it knows and what's missing:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    };
  } else {
    return {
      subject: p.lang === "pl" ? `Mogę pomóc ${p.domain} z AI?` : `Can I help ${p.domain} with AI?`,
      html: p.lang === "pl"
        ? `<p>${hi}</p><p>Jestem Jakub, studiuję informatykę w Polsce i pomagam firmom wdrażać AI żeby rosły. Zbudowałem asystenta AI, który czyta Twoją stronę i odpowiada na pytania klientów 24/7.</p><p>Już zrobiłem jednego dla ${p.domain} - zna Twoje usługi, cennik i wszystko co jest na stronie:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`
        : `<p>${hi}</p><p>I'm Jakub, I study Computer Science in Poland and I'm helping businesses onboard AI to grow. I built an AI assistant that reads your website and can answer customer questions 24/7.</p><p>I already made one for ${p.domain} - it knows your services, pricing, and everything on your site:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    };
  }
}

async function sendEmail(p: Prospect, demoUrl: string, template: string): Promise<boolean> {
  const { subject, html } = getEmailHtml(p, demoUrl, template);
  const unsubUrl = `${BASE_URL}/unsubscribe?email=${encodeURIComponent(p.email)}`;
  try {
    const resp = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${RESEND_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: FROM, to: [p.email], subject, html, reply_to: "jakub@whisp.so",
        headers: { "List-Unsubscribe": `<${unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      if (err.includes("429") || err.includes("quota")) { console.log("  QUOTA HIT"); return false; }
      console.log(`  FAIL: ${err.slice(0, 80)}`);
    }
    return resp.ok;
  } catch { return false; }
}

async function main() {
  const keywords = INDUSTRY_KEYWORDS[INDUSTRY] || [INDUSTRY];
  console.log(`Apollo pipeline: ${INDUSTRY} in ${COUNTRY}, limit ${LIMIT}${SEND ? "" : " (DRY RUN)"}`);
  console.log(`Keywords: ${keywords.join(", ")}\n`);

  // Step 1: Search Apollo
  console.log("=== SEARCHING APOLLO ===");
  const seenDomains = new Set<string>();
  const prospects: Prospect[] = [];
  let page = 1;

  while (prospects.length < LIMIT) {
    const result = await searchApollo(keywords, COUNTRY, page);
    if (!result.people || result.people.length === 0) break;

    console.log(`  Page ${page}: ${result.people.length} results (${result.total_entries} total)`);

    for (const person of result.people) {
      if (prospects.length >= LIMIT) break;
      if (!person.has_email) continue;

      // Enrich to get email + domain
      console.log(`  Enriching ${person.first_name} @ ${person.organization?.name}...`);
      const enriched = await enrichPerson(person.id);
      const ep = enriched.person;
      if (!ep?.email || !ep?.organization?.primary_domain) {
        console.log(`    Skip - no email or domain`);
        continue;
      }

      const domain = ep.organization.primary_domain;
      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);

      const country = ep.country || COUNTRY;
      prospects.push({
        apolloId: ep.id,
        firstName: ep.first_name,
        email: ep.email,
        domain,
        orgName: ep.organization.name,
        title: ep.title,
        country,
        lang: isPolish(country) ? "pl" : "en",
      });

      console.log(`    ✓ ${ep.first_name} <${ep.email}> @ ${domain}`);
      await new Promise(r => setTimeout(r, 500));
    }

    page++;
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\nFound ${prospects.length} unique prospects\n`);

  if (prospects.length === 0) return;

  // Step 2: Register domains on Whisp
  console.log("=== REGISTERING DOMAINS ===");
  const registered: { prospect: Prospect; tenantId: string }[] = [];

  for (const p of prospects) {
    const tid = await registerTenant(p.domain);
    if (tid) {
      registered.push({ prospect: p, tenantId: tid });
      console.log(`  ✓ ${p.domain}`);
    } else {
      console.log(`  ✗ ${p.domain}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nRegistered: ${registered.length}\n`);

  // Step 3: Wait for scraping (up to 15 min)
  console.log("=== WAITING FOR SCRAPING ===");
  const maxWait = 15 * 60 * 1000;
  const start = Date.now();

  while (Date.now() - start < maxWait) {
    const tenantsResp = await fetch(`${BASE_URL}/api/admin/tenants?secret=${ADMIN_SECRET}`);
    const allTenants = (await tenantsResp.json()) as any[];
    const tenantMap = new Map(allTenants.map((t: any) => [t.id, t]));

    let readyCount = 0;
    for (const r of registered) {
      const t = tenantMap.get(r.tenantId);
      if (t && t.status === "active" && t.chunksCount > 0) readyCount++;
    }

    console.log(`  ${readyCount}/${registered.length} ready (${Math.round((Date.now() - start) / 1000)}s)`);
    if (readyCount >= registered.length * 0.5 || readyCount >= 20) break;
    await new Promise(r => setTimeout(r, 30000));
  }

  // Step 4: Send emails
  console.log("\n=== SENDING EMAILS ===");
  const templates = ["clean", "gaps", "personal"];
  let sent = 0, skipped = 0;

  // Get current tenant state
  const tenantsResp = await fetch(`${BASE_URL}/api/admin/tenants?secret=${ADMIN_SECRET}`);
  const allTenants = (await tenantsResp.json()) as any[];
  const tenantMap = new Map(allTenants.map((t: any) => [t.id, t]));

  // Get unsub list
  let unsubs: string[] = [];
  try {
    const unsubResp = await fetch(`${BASE_URL}/api/admin/unsubscribed?secret=${ADMIN_SECRET}`);
    if (unsubResp.ok) unsubs = (await unsubResp.json()) as string[];
  } catch {}
  const unsubSet = new Set(unsubs.map(e => e.toLowerCase()));

  for (let i = 0; i < registered.length; i++) {
    const { prospect, tenantId } = registered[i];
    const tenant = tenantMap.get(tenantId);

    if (!tenant || tenant.status !== "active" || tenant.chunksCount === 0) {
      console.log(`  SKIP ${prospect.domain} (not ready)`);
      skipped++;
      continue;
    }
    if (unsubSet.has(prospect.email.toLowerCase())) {
      console.log(`  UNSUB ${prospect.domain}`);
      skipped++;
      continue;
    }

    const template = templates[i % 3];
    const demoUrl = `${BASE_URL}/demo/${tenantId}`;

    if (!SEND) {
      console.log(`  [DRY] [${template}] [${prospect.lang}] ${prospect.firstName} <${prospect.email}> @ ${prospect.domain}`);
      sent++;
      continue;
    }

    const ok = await sendEmail(prospect, demoUrl, template);
    if (ok) {
      sent++;
      console.log(`  ✉️  [${template}] [${prospect.lang}] ${prospect.firstName} <${prospect.email}> @ ${prospect.domain}`);
    } else {
      if (sent > 0) { console.log("  Stopping (quota or error)"); break; }
      skipped++;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n=== DONE ===`);
  console.log(`Prospects found: ${prospects.length}`);
  console.log(`Domains registered: ${registered.length}`);
  console.log(`Emails sent: ${sent}`);
  console.log(`Skipped: ${skipped}`);
  console.log(`Apollo credits used: ~${prospects.length} (enrichment)`);
}

main().catch(console.error);
