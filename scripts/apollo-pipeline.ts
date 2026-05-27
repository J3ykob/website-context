/**
 * Apollo → Whisp pipeline: find prospects, enrich, register, send.
 *
 * Usage:
 *   npx tsx scripts/apollo-pipeline.ts --industry=hotel --country=Poland --limit=30 --dry-run
 *   npx tsx scripts/apollo-pipeline.ts --industry=restaurant --country="United Kingdom,Netherlands" --limit=50 --send
 *   npx tsx scripts/apollo-pipeline.ts --industry=dental --country=all-eu --limit=100 --send
 *
 * Industries: hotel, restaurant, law, realestate, salon, dental, fitness, auto, education, wedding, tattoo
 * Countries: any Apollo location string, comma-separated, or "all-eu" for all European
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || "https://whisp.so";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "whisp-admin-2026";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const APOLLO_KEY = process.env.APOLLO_API_KEY || "";
const FROM = "Jakub <jakub@whisp.so>";
const SEND = process.argv.includes("--send");
const LIMIT = parseInt(process.argv.find(a => a.startsWith("--limit="))?.split("=")[1] || "30");
const INDUSTRY = process.argv.find(a => a.startsWith("--industry="))?.split("=")[1] || "hotel";
const COUNTRY_ARG = process.argv.find(a => a.startsWith("--country="))?.split("=")[1] || "Poland";

if (!APOLLO_KEY) {
  console.error("APOLLO_API_KEY env var required");
  process.exit(1);
}

const EU_COUNTRIES = ["Poland", "United Kingdom", "Germany", "France", "Italy", "Spain", "Netherlands", "Sweden", "Portugal", "Belgium", "Austria", "Czech Republic", "Denmark", "Norway", "Ireland"];
const COUNTRIES = COUNTRY_ARG === "all-eu" ? EU_COUNTRIES : COUNTRY_ARG.split(",").map(c => c.trim());

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

const PL_PATTERNS = ["poland", ".pl"];
function detectLang(country: string, domain: string): "pl" | "en" {
  const lower = country.toLowerCase() + " " + domain.toLowerCase();
  return PL_PATTERNS.some(p => lower.includes(p)) ? "pl" : "en";
}

// --- Sent log: tracks every email we've ever sent to avoid duplicates ---
const SENT_LOG_PATH = resolve(__dirname, "../data/pipeline-sent.json");
let sentLog: Record<string, { sentAt: string; template: string; industry: string }> = {};
try { sentLog = JSON.parse(readFileSync(SENT_LOG_PATH, "utf-8")); } catch {}
function markSent(email: string, template: string) {
  sentLog[email.toLowerCase()] = { sentAt: new Date().toISOString(), template, industry: INDUSTRY };
  writeFileSync(SENT_LOG_PATH, JSON.stringify(sentLog, null, 2));
}
function alreadySent(email: string): boolean {
  return email.toLowerCase() in sentLog;
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

async function searchApollo(keywords: string[], countries: string[], page: number): Promise<any> {
  const resp = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    body: JSON.stringify({
      q_organization_keyword_tags: keywords,
      organization_locations: countries,
      organization_num_employees_ranges: ["1,50"],
      person_seniorities: ["owner", "founder", "c_suite"],
      contact_email_status: ["verified"],
      page,
      per_page: 100,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!resp.ok) {
    const err = await resp.text();
    if (resp.status === 429) {
      console.log("  Apollo rate limit — waiting 60s");
      await new Promise(r => setTimeout(r, 60000));
      return searchApollo(keywords, countries, page);
    }
    throw new Error(`Apollo search failed (${resp.status}): ${err.slice(0, 100)}`);
  }
  return resp.json();
}

async function enrichPerson(id: string): Promise<any> {
  const resp = await fetch("https://api.apollo.io/api/v1/people/match", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    body: JSON.stringify({ id }),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) {
    if (resp.status === 429) {
      console.log("    Apollo rate limit — waiting 60s");
      await new Promise(r => setTimeout(r, 60000));
      return enrichPerson(id);
    }
    return { person: null };
  }
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
    return data.tenantId || (data.error?.includes("already exists") ? domain.replace(/[^a-zA-Z0-9]/g, "_") : null);
  } catch { return null; }
}

async function getExistingTenantDomains(): Promise<Set<string>> {
  try {
    const resp = await fetch(`${BASE_URL}/api/admin/tenants?secret=${ADMIN_SECRET}`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return new Set();
    const text = await resp.text();
    if (text.startsWith("<")) return new Set(); // HTML error page
    const tenants = JSON.parse(text) as any[];
    return new Set(tenants.map((t: any) => t.domain));
  } catch { return new Set(); }
}

async function fetchTenantsMap(): Promise<Map<string, any>> {
  try {
    const resp = await fetch(`${BASE_URL}/api/admin/tenants?secret=${ADMIN_SECRET}`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return new Map();
    const text = await resp.text();
    if (text.startsWith("<")) return new Map();
    const tenants = JSON.parse(text) as any[];
    return new Map(tenants.map((t: any) => [t.domain, t]));
  } catch { return new Map(); }
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

async function sendEmail(p: Prospect, demoUrl: string, template: string): Promise<"sent" | "quota" | "fail"> {
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
    if (resp.ok) return "sent";
    const err = await resp.text();
    if (err.includes("429") || err.includes("quota")) return "quota";
    console.log(`  FAIL: ${err.slice(0, 80)}`);
    return "fail";
  } catch { return "fail"; }
}

async function main() {
  const allIndustries = INDUSTRY === "all" ? Object.keys(INDUSTRY_KEYWORDS) : [INDUSTRY];
  const keywords = allIndustries.flatMap(i => INDUSTRY_KEYWORDS[i] || [i]);
  console.log(`Apollo pipeline: ${allIndustries.join(", ")} in ${COUNTRIES.join(", ")}`);
  console.log(`Limit: ${LIMIT} | ${SEND ? "SENDING" : "DRY RUN"}`);
  console.log(`Keywords: ${keywords.slice(0, 10).join(", ")}${keywords.length > 10 ? ` (+${keywords.length - 10} more)` : ""}\n`);

  // Load existing state
  const existingDomains = await getExistingTenantDomains();
  console.log(`Existing tenants: ${existingDomains.size}`);
  console.log(`Previously sent emails: ${Object.keys(sentLog).length}\n`);

  // Step 1: Search Apollo — collect candidates WITHOUT enriching yet
  console.log("=== SEARCHING APOLLO ===");
  const candidates: { id: string; firstName: string; orgName: string; orgDomain?: string }[] = [];
  const seenOrgs = new Set<string>();
  let page = 1;
  let totalCreditsNeeded = 0;

  while (candidates.length < LIMIT * 2) { // overfetch since some will be dupes
    const result = await searchApollo(keywords, COUNTRIES, page);
    if (!result.people || result.people.length === 0) break;

    console.log(`  Page ${page}: ${result.people.length} results (${result.total_entries} total in Apollo)`);

    for (const person of result.people) {
      if (!person.has_email) continue;
      const orgName = person.organization?.name;
      if (!orgName || seenOrgs.has(orgName)) continue;
      seenOrgs.add(orgName);

      candidates.push({
        id: person.id,
        firstName: person.first_name,
        orgName,
      });
    }

    page++;
    if (page > 10) break; // safety: max 1000 results
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`\nCandidates found: ${candidates.length}`);

  // Step 2: Enrich only what we need — skip already-sent, skip existing tenants
  console.log("\n=== ENRICHING (1 credit each) ===");
  const prospects: Prospect[] = [];
  let creditsUsed = 0;
  let skippedDupe = 0;

  for (const c of candidates) {
    if (prospects.length >= LIMIT) break;

    const enriched = await enrichPerson(c.id);
    creditsUsed++;
    const ep = enriched.person;

    if (!ep?.email || !ep?.organization?.primary_domain) {
      console.log(`  ✗ ${c.orgName} — no email or domain`);
      continue;
    }

    const domain = ep.organization.primary_domain;
    const email = ep.email;

    // Skip if we already emailed this person
    if (alreadySent(email)) {
      console.log(`  SKIP ${domain} — already emailed ${email}`);
      skippedDupe++;
      continue;
    }

    // Skip consultancies/agencies (no real business website)
    if (domain.includes("linkedin.com") || domain.includes("facebook.com")) continue;

    const country = ep.country || COUNTRIES[0];
    const lang = detectLang(country, domain);

    prospects.push({
      apolloId: ep.id,
      firstName: ep.first_name,
      email,
      domain,
      orgName: ep.organization.name,
      title: ep.title,
      country,
      lang,
    });

    console.log(`  ✓ ${ep.first_name} <${email}> @ ${domain} [${lang}]`);
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\nProspects: ${prospects.length} | Credits used: ${creditsUsed} | Skipped dupes: ${skippedDupe}\n`);
  if (prospects.length === 0) return;

  // Step 3: Register new domains (skip already existing)
  console.log("=== REGISTERING DOMAINS ===");
  const toRegister = prospects.filter(p => !existingDomains.has(p.domain));
  const alreadyRegistered = prospects.length - toRegister.length;
  console.log(`  ${alreadyRegistered} already registered, ${toRegister.length} new`);

  for (const p of toRegister) {
    const tid = await registerTenant(p.domain);
    if (tid) {
      console.log(`  ✓ ${p.domain}`);
    } else {
      console.log(`  ✗ ${p.domain}`);
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Step 4: Send emails to ready tenants, queue the rest
  // Don't wait for scraping — send what's ready now, log the rest for next run
  console.log("\n=== SENDING EMAILS ===");

  // Give new registrations a moment to start scraping
  if (toRegister.length > 0) {
    console.log("  Waiting 30s for scraper to start...");
    await new Promise(r => setTimeout(r, 30000));
  }

  const tenantMap = await fetchTenantsMap();

  let unsubs: string[] = [];
  try {
    const unsubResp = await fetch(`${BASE_URL}/api/admin/unsubscribed?secret=${ADMIN_SECRET}`);
    if (unsubResp.ok) unsubs = (await unsubResp.json()) as string[];
  } catch {}
  const unsubSet = new Set(unsubs.map(e => e.toLowerCase()));

  const templates = ["clean", "gaps", "personal"];
  let sent = 0, skipped = 0, notReady = 0;

  for (let i = 0; i < prospects.length; i++) {
    const p = prospects[i];
    const tenant = tenantMap.get(p.domain);

    if (!tenant || tenant.status !== "active" || !tenant.chunksCount) {
      notReady++;
      continue;
    }
    if (unsubSet.has(p.email.toLowerCase())) {
      console.log(`  UNSUB ${p.domain}`);
      skipped++;
      continue;
    }
    if (alreadySent(p.email)) {
      skipped++;
      continue;
    }

    const template = templates[i % 3];
    const demoUrl = `${BASE_URL}/demo/${tenant.id}`;

    if (!SEND) {
      console.log(`  [DRY] [${template}] [${p.lang}] ${p.firstName} <${p.email}> @ ${p.domain}`);
      sent++;
      continue;
    }

    const result = await sendEmail(p, demoUrl, template);
    if (result === "sent") {
      sent++;
      markSent(p.email, template);
      console.log(`  ✉️  [${template}] [${p.lang}] ${p.firstName} <${p.email}> @ ${p.domain}`);
    } else if (result === "quota") {
      console.log("  QUOTA HIT — stopping. Run again tomorrow for the rest.");
      break;
    } else {
      skipped++;
    }

    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`\n=== DONE ===`);
  console.log(`Apollo credits used: ${creditsUsed}`);
  console.log(`Prospects found: ${prospects.length}`);
  console.log(`Emails sent: ${sent}`);
  console.log(`Not ready (will be sent next run): ${notReady}`);
  console.log(`Skipped: ${skipped}`);
  if (notReady > 0) {
    console.log(`\nTip: Run again in 30 min to send to newly scraped tenants.`);
  }
}

main().catch(console.error);
