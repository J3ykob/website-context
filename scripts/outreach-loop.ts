/**
 * Synchronous outreach loop — one prospect at a time, start to finish.
 *
 * For each prospect:
 *   1. Search Apollo → pick next candidate
 *   2. Enrich → get verified email + domain
 *   3. Register domain with priority scraping
 *   4. Wait for scrape to complete (~1-2 min)
 *   5. Send email
 *   6. Next prospect
 *
 * Stops at Resend daily quota, resumes next day.
 *
 * Usage:
 *   APOLLO_API_KEY=xxx RESEND_API_KEY=xxx npx tsx scripts/outreach-loop.ts
 *   APOLLO_API_KEY=xxx RESEND_API_KEY=xxx npx tsx scripts/outreach-loop.ts --dry-run
 */

import { readFileSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = process.env.BASE_URL || "https://whisp.so";
const ADMIN_SECRET = process.env.ADMIN_SECRET || "whisp-admin-2026";
const RESEND_KEY = process.env.RESEND_API_KEY || "";
const APOLLO_KEY = process.env.APOLLO_API_KEY || "";
const FROM = "Jakub <jakub@whisp.so>";
const SEND = !process.argv.includes("--dry-run");

if (!APOLLO_KEY) { console.error("APOLLO_API_KEY required"); process.exit(1); }
if (!RESEND_KEY && SEND) { console.error("RESEND_API_KEY required"); process.exit(1); }

const EU_COUNTRIES = ["Poland", "United Kingdom", "Germany", "France", "Italy", "Spain", "Netherlands", "Sweden", "Portugal", "Belgium", "Austria", "Czech Republic", "Denmark", "Norway", "Ireland"];

const ALL_KEYWORDS = [
  "hotel", "boutique hotel", "bed and breakfast", "guesthouse",
  "restaurant", "cafe", "bistro", "catering",
  "law firm", "legal services", "solicitors", "notary",
  "real estate", "property management", "letting agent", "estate agent",
  "hair salon", "barbershop", "beauty salon", "nail salon",
  "dental", "dentist", "orthodontist", "dental clinic",
  "gym", "fitness center", "crossfit", "yoga studio", "pilates",
  "auto repair", "car service", "car dealership", "garage", "body shop",
  "school", "language school", "tutoring", "driving school",
  "wedding venue", "event venue", "event planning",
  "tattoo studio", "piercing studio",
  "spa", "massage", "physiotherapy", "wellness center", "chiropractic",
  "veterinary", "vet clinic", "animal hospital",
  "accounting", "bookkeeper", "tax advisor",
  "photographer", "photo studio", "videographer",
  "online shop", "retail store", "boutique",
  "contractor", "renovation", "construction company", "builder", "roofing",
  "cleaning service", "janitorial",
  "carpenter", "joinery", "woodworking", "furniture maker",
  "plumber", "plumbing", "heating engineer", "hvac",
  "electrician", "electrical contractor",
  "landscaping", "garden design", "lawn care",
  "moving company", "removals", "relocation",
  "insurance broker", "insurance agency",
  "travel agency", "tour operator",
  "printing", "print shop", "signage",
  "florist", "flower shop",
  "bakery", "patisserie", "confectionery",
  "pharmacy", "optician", "eye care",
  "pet shop", "pet grooming", "dog training",
  "tailor", "alterations", "dressmaker",
  "jewelry", "jeweller", "watchmaker",
  "music school", "recording studio",
  "therapy", "counseling", "psychologist",
  "coworking", "serviced office",
];

// --- Persistent state ---
const SENT_LOG_PATH = resolve(__dirname, "../data/pipeline-sent.json");
const STATE_PATH = resolve(__dirname, "../data/outreach-state.json");

let sentLog: Record<string, { sentAt: string; template: string }> = {};
try { sentLog = JSON.parse(readFileSync(SENT_LOG_PATH, "utf-8")); } catch {}

interface LoopState {
  apolloPage: number;
  apolloIndex: number;
  keywordOffset: number;
  totalEnriched: number;
  totalSent: number;
  quotaHitAt: string | null;
}

let state: LoopState = { apolloPage: 1, apolloIndex: 0, keywordOffset: 0, totalEnriched: 0, totalSent: 0, quotaHitAt: null };
try { const s = JSON.parse(readFileSync(STATE_PATH, "utf-8")); state = { ...state, ...s }; } catch {}

function saveState() { writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
function saveSentLog() { writeFileSync(SENT_LOG_PATH, JSON.stringify(sentLog, null, 2)); }
function alreadySent(email: string): boolean { return email.toLowerCase() in sentLog; }
function markSent(email: string, template: string) {
  sentLog[email.toLowerCase()] = { sentAt: new Date().toISOString(), template };
  saveSentLog();
}

function detectLang(country: string, domain: string): "pl" | "en" {
  const lower = (country + " " + domain).toLowerCase();
  return lower.includes("poland") || lower.includes(".pl") ? "pl" : "en";
}

function getKeywords(): string[] {
  const size = 15;
  const start = (state.keywordOffset * size) % ALL_KEYWORDS.length;
  return ALL_KEYWORDS.slice(start, start + size);
}

// --- Apollo ---
let cachedPage: any[] = [];

async function fetchPage(): Promise<any[]> {
  const keywords = getKeywords();
  console.log(`  [apollo] Searching page ${state.apolloPage}, keywords: ${keywords.slice(0, 4).join(", ")}...`);
  const resp = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    body: JSON.stringify({
      q_organization_keyword_tags: keywords,
      organization_locations: EU_COUNTRIES,
      organization_num_employees_ranges: ["1,50"],
      person_seniorities: ["owner", "founder", "c_suite"],
      contact_email_status: ["verified"],
      page: state.apolloPage,
      per_page: 100,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 429) {
    console.log("  [apollo] Rate limited — waiting 60s");
    await new Promise(r => setTimeout(r, 60000));
    return fetchPage();
  }
  if (!resp.ok) throw new Error(`Apollo ${resp.status}`);
  const data = await resp.json();
  console.log(`  [apollo] ${data.people?.length || 0} results (${data.total_entries} total)`);
  return data.people || [];
}

async function getNextCandidate(): Promise<any | null> {
  while (true) {
    if (state.apolloIndex >= cachedPage.length) {
      cachedPage = await fetchPage();
      state.apolloIndex = 0;
      if (cachedPage.length === 0) {
        // Move to next keyword set
        state.keywordOffset++;
        state.apolloPage = 1;
        saveState();
        console.log(`  [apollo] No results, rotating keywords (offset ${state.keywordOffset})`);
        if (state.keywordOffset > ALL_KEYWORDS.length / 15) {
          console.log("  [apollo] All keywords exhausted, wrapping around");
          state.keywordOffset = 0;
          state.apolloPage = 1;
        }
        cachedPage = await fetchPage();
        if (cachedPage.length === 0) return null;
      }
    }

    const person = cachedPage[state.apolloIndex];
    state.apolloIndex++;

    if (!person.has_email) continue;
    if (!person.organization?.name) continue;

    return person;
  }
}

async function enrichPerson(id: string): Promise<any> {
  const resp = await fetch("https://api.apollo.io/api/v1/people/match", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    body: JSON.stringify({ id }),
    signal: AbortSignal.timeout(10000),
  });
  if (resp.status === 429) {
    console.log("  [apollo] Rate limited — waiting 60s");
    await new Promise(r => setTimeout(r, 60000));
    return enrichPerson(id);
  }
  if (!resp.ok) return { person: null };
  return resp.json();
}

// --- Whisp ---
async function registerTenant(domain: string, retries = 3): Promise<string | null> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const resp = await fetch(`${BASE_URL}/api/tenants?secret=${ADMIN_SECRET}&priority=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl: `https://${domain}`, email: `info@${domain}` }),
        signal: AbortSignal.timeout(10000),
      });
      const text = await resp.text();
      if (text.startsWith("<")) {
        console.log(`  [register] Server not ready (attempt ${attempt}/${retries})`);
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }
      const data = JSON.parse(text);
      if (data.tenantId) return data.tenantId;
      if (data.error?.includes("already exists")) {
        const tid = data.tenantId || domain.replace(/[^a-zA-Z0-9]/g, "_");
        await fetch(`${BASE_URL}/api/admin/rescrape/${tid}?secret=${ADMIN_SECRET}`, {
          method: "POST", signal: AbortSignal.timeout(5000),
        }).catch(() => {});
        return tid;
      }
      return null;
    } catch {
      if (attempt < retries) {
        console.log(`  [register] Error (attempt ${attempt}/${retries}), retrying in 15s...`);
        await new Promise(r => setTimeout(r, 15000));
      }
    }
  }
  return null;
}

async function waitForScrape(domain: string, maxWaitMs: number = 300000): Promise<{ ready: boolean; tenantId?: string }> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const resp = await fetch(`${BASE_URL}/api/admin/tenants?secret=${ADMIN_SECRET}`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) { await new Promise(r => setTimeout(r, 5000)); continue; }
      const text = await resp.text();
      if (text.startsWith("<")) { await new Promise(r => setTimeout(r, 5000)); continue; }
      const tenants = JSON.parse(text) as any[];
      const t = tenants.find((x: any) => x.domain === domain);
      if (t && t.status === "active" && t.chunksCount > 0) {
        return { ready: true, tenantId: t.id };
      }
      const elapsed = Math.round((Date.now() - start) / 1000);
      process.stdout.write(`\r  [scrape] Waiting for ${domain}... ${elapsed}s`);
    } catch {}
    await new Promise(r => setTimeout(r, 10000));
  }
  console.log();
  return { ready: false };
}

async function getUnsubSet(): Promise<Set<string>> {
  try {
    const resp = await fetch(`${BASE_URL}/api/admin/unsubscribed?secret=${ADMIN_SECRET}`);
    if (!resp.ok) return new Set();
    return new Set(((await resp.json()) as string[]).map(e => e.toLowerCase()));
  } catch { return new Set(); }
}

// --- Email ---
function buildEmail(firstName: string, email: string, domain: string, lang: "pl" | "en", demoUrl: string, template: string): { subject: string; html: string } {
  const unsub = `<p style="font-size:11px;color:#999;"><a href="${BASE_URL}/unsubscribe?email=${encodeURIComponent(email)}" style="color:#999;">${lang === "pl" ? "Wypisz się" : "Unsubscribe"}</a></p>`;
  const sig = `<p>Jakub<br>whisp.so</p>`;
  const cta = lang === "pl"
    ? `<p>Mogę to uruchomić na Twojej stronie do jutra - wystarczy odpowiedzieć na tego maila lub <a href="https://cal.com/whisp/15min">umówić się na rozmowę</a>.</p>`
    : `<p>I can have this running on your site by tomorrow - you can reply here or <a href="https://cal.com/whisp/15min">book a call</a> with me to discuss it in details.</p>`;
  const hi = lang === "pl" ? `Cześć ${firstName},` : `Hi ${firstName},`;

  if (template === "clean") {
    return {
      subject: lang === "pl" ? `Zbudowałem darmowego asystenta AI dla ${domain}` : `I built a free AI assistant for ${domain}`,
      html: lang === "pl"
        ? `<p>${hi}</p><p>Zbudowałem asystenta AI, który czyta ${domain} i odpowiada na pytania odwiedzających - usługi, cennik, lokalizacja, godziny otwarcia, wszystko co jest na stronie.</p><p>Już zna Twoją stronę. Możesz go wypróbować tutaj:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`
        : `<p>${hi}</p><p>I built an AI assistant that reads ${domain} and answers visitor questions - pricing, services, location, hours, anything on your site.</p><p>It already knows your website. You can try it here:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    };
  } else if (template === "gaps") {
    return {
      subject: lang === "pl" ? `Przetestowałem ${domain} z perspektywy klienta` : `I tested ${domain} from a customer's perspective`,
      html: lang === "pl"
        ? `<p>${hi}</p><p>Zbudowałem AI, który czyta Twoją stronę i odpowiada na pytania odwiedzających. Przetestowałem go na ${domain} - większość odpowiedzi była dobra, ale kilka typowych pytań zostawiło odwiedzających bez jasnej odpowiedzi.</p><p>Zobacz co wie i czego mu brakuje:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`
        : `<p>${hi}</p><p>I built an AI that reads your website and answers visitor questions. I tested it on ${domain} - most questions got good answers, but a few common ones left visitors without a clear next step.</p><p>You can see exactly what it knows and what's missing:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    };
  } else {
    return {
      subject: lang === "pl" ? `Mogę pomóc ${domain} z AI?` : `Can I help ${domain} with AI?`,
      html: lang === "pl"
        ? `<p>${hi}</p><p>Jestem Jakub, studiuję informatykę w Polsce i pomagam firmom wdrażać AI żeby rosły. Zbudowałem asystenta AI, który czyta Twoją stronę i odpowiada na pytania klientów 24/7.</p><p>Już zrobiłem jednego dla ${domain} - zna Twoje usługi, cennik i wszystko co jest na stronie:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`
        : `<p>${hi}</p><p>I'm Jakub, I study Computer Science in Poland and I'm helping businesses onboard AI to grow. I built an AI assistant that reads your website and can answer customer questions 24/7.</p><p>I already made one for ${domain} - it knows your services, pricing, and everything on your site:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    };
  }
}

async function sendEmail(firstName: string, email: string, domain: string, lang: "pl" | "en", demoUrl: string, template: string): Promise<"sent" | "quota" | "fail"> {
  const { subject, html } = buildEmail(firstName, email, domain, lang, demoUrl, template);
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
    if (resp.ok) return "sent";
    const err = await resp.text();
    if (err.includes("429") || err.includes("quota")) return "quota";
    console.log(`  [resend] FAIL: ${err.slice(0, 80)}`);
    return "fail";
  } catch { return "fail"; }
}

// --- Main loop ---
const templates = ["clean", "gaps", "personal"];

async function processOne(): Promise<"sent" | "quota" | "skip" | "done"> {
  // 1. Find next candidate
  const candidate = await getNextCandidate();
  if (!candidate) return "done";

  // 2. Enrich
  console.log(`\n[${state.totalSent + 1}] Enriching ${candidate.first_name} @ ${candidate.organization?.name}...`);
  const enriched = await enrichPerson(candidate.id);
  state.totalEnriched++;
  const ep = enriched.person;

  if (!ep?.email || !ep?.organization?.primary_domain) {
    console.log("  Skip - no email or domain");
    return "skip";
  }

  const domain = ep.organization.primary_domain;
  const email = ep.email;
  const firstName = ep.first_name;

  if (alreadySent(email)) { console.log(`  Skip - already emailed ${email}`); return "skip"; }
  // Check if we already emailed someone at this domain
  const domainEmailed = Object.entries(sentLog).some(([e, _]) => e.endsWith("@" + domain) || e.endsWith("." + domain));
  if (domainEmailed) { console.log(`  Skip - already emailed someone at ${domain}`); return "skip"; }
  if (domain.includes("linkedin.com") || domain.includes("facebook.com")) { console.log("  Skip - social domain"); return "skip"; }

  const country = ep.country || "Unknown";
  const lang = detectLang(country, domain);
  console.log(`  Found: ${firstName} <${email}> @ ${domain} [${lang}] (${ep.title})`);

  // 3. Register with priority
  console.log(`  [register] ${domain}...`);
  const tid = await registerTenant(domain);
  if (!tid) { console.log("  Skip - registration failed"); return "skip"; }

  // 4. Wait for scrape
  console.log(`  [scrape] Waiting for ${domain} to finish...`);
  const { ready, tenantId } = await waitForScrape(domain, 300000);
  if (!ready) { console.log(`\n  Skip - scrape timeout for ${domain}`); return "skip"; }

  // 5. Check unsub
  const unsubSet = await getUnsubSet();
  if (unsubSet.has(email.toLowerCase())) { console.log("  Skip - unsubscribed"); return "skip"; }

  // 6. Send email
  const template = templates[state.totalSent % 3];
  const demoUrl = `${BASE_URL}/demo/${tenantId}`;

  if (!SEND) {
    console.log(`  [DRY] Would send [${template}] [${lang}] to ${firstName} <${email}>`);
    state.totalSent++;
    saveState();
    return "sent";
  }

  const result = await sendEmail(firstName, email, domain, lang, demoUrl, template);
  if (result === "sent") {
    markSent(email, template);
    state.totalSent++;
    saveState();
    console.log(`  ✉️  [${template}] [${lang}] ${firstName} <${email}> @ ${domain}`);
    return "sent";
  } else if (result === "quota") {
    console.log("  QUOTA HIT - stopping for today");
    state.quotaHitAt = new Date().toISOString();
    saveState();
    return "quota";
  }
  return "skip";
}

async function main() {
  console.log("=== SYNCHRONOUS OUTREACH LOOP ===");
  console.log(`${SEND ? "SENDING" : "DRY RUN"} | Sent log: ${Object.keys(sentLog).length} previous`);
  console.log(`State: page=${state.apolloPage} enriched=${state.totalEnriched} sent=${state.totalSent}\n`);

  // Reset quota if new day
  if (state.quotaHitAt) {
    const hitDate = new Date(state.quotaHitAt).toDateString();
    if (hitDate !== new Date().toDateString()) {
      console.log("New day - resetting quota flag\n");
      state.quotaHitAt = null;
      saveState();
    }
  }

  while (true) {
    // Check quota
    if (state.quotaHitAt && new Date(state.quotaHitAt).toDateString() === new Date().toDateString()) {
      console.log("\nQuota hit today. Waiting 1 hour...");
      await new Promise(r => setTimeout(r, 3600000));
      if (new Date(state.quotaHitAt!).toDateString() !== new Date().toDateString()) {
        state.quotaHitAt = null;
        saveState();
        console.log("New day - resuming!\n");
      }
      continue;
    }

    const result = await processOne();

    if (result === "quota") continue;
    if (result === "done") {
      // Advance to next keyword set
      state.keywordOffset++;
      state.apolloPage = 1;
      state.apolloIndex = 0;
      cachedPage = [];
      saveState();
      console.log("Advancing to next keyword set...\n");
    }

    // Small pause between prospects
    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(console.error);
