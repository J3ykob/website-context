/**
 * Synchronous outreach loop - one prospect at a time, no waste.
 *
 * 1. First: drain any pending prospects (send those already scraped)
 * 2. Then: find one -> enrich -> register -> wait for scrape -> send -> repeat
 *
 * Every Apollo credit = one email sent. No queue buildup.
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

interface Prospect { firstName: string; email: string; domain: string; orgName: string; title: string; country: string; lang: "pl" | "en"; }

interface LoopState {
  apolloPage: number;
  apolloIndex: number;
  keywordOffset: number;
  totalEnriched: number;
  totalSent: number;
  quotaHitAt: string | null;
  pending: Prospect[];
}

let state: LoopState = { apolloPage: 1, apolloIndex: 0, keywordOffset: 0, totalEnriched: 0, totalSent: 0, quotaHitAt: null, pending: [] };
try { const s = JSON.parse(readFileSync(STATE_PATH, "utf-8")); state = { ...state, ...s }; } catch {}

function saveState() { writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
function saveSentLog() { writeFileSync(SENT_LOG_PATH, JSON.stringify(sentLog, null, 2)); }
function alreadySent(email: string): boolean { return email.toLowerCase() in sentLog; }
function domainSent(domain: string): boolean { return Object.keys(sentLog).some(e => e.endsWith("@" + domain) || e.endsWith("." + domain)); }
function markSent(email: string, template: string) { sentLog[email.toLowerCase()] = { sentAt: new Date().toISOString(), template }; saveSentLog(); }

function detectLang(country: string, domain: string): "pl" | "en" {
  return (country + " " + domain).toLowerCase().includes("poland") || domain.endsWith(".pl") ? "pl" : "en";
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
  console.log(`  [apollo] Page ${state.apolloPage}, keywords: ${keywords.slice(0, 4).join(", ")}...`);
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
  if (resp.status === 429) { console.log("  [apollo] Rate limited - 60s"); await new Promise(r => setTimeout(r, 60000)); return fetchPage(); }
  if (!resp.ok) throw new Error(`Apollo ${resp.status}`);
  const data = await resp.json();
  return data.people || [];
}

async function getNextCandidate(): Promise<any | null> {
  if (state.apolloIndex >= cachedPage.length) {
    state.apolloPage++;
    cachedPage = await fetchPage();
    state.apolloIndex = 0;
    if (cachedPage.length === 0) {
      state.keywordOffset++;
      state.apolloPage = 1;
      if (state.keywordOffset > ALL_KEYWORDS.length / 15) state.keywordOffset = 0;
      cachedPage = await fetchPage();
      if (cachedPage.length === 0) return null;
    }
  }
  return cachedPage[state.apolloIndex++];
}

async function enrichPerson(id: string): Promise<any> {
  const resp = await fetch("https://api.apollo.io/api/v1/people/match", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    body: JSON.stringify({ id }),
    signal: AbortSignal.timeout(10000),
  });
  if (resp.status === 429) { console.log("  [apollo] Rate limited - 60s"); await new Promise(r => setTimeout(r, 60000)); return enrichPerson(id); }
  if (!resp.ok) return { person: null };
  return resp.json();
}

// --- Whisp ---
async function registerTenant(domain: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const resp = await fetch(`${BASE_URL}/api/tenants?secret=${ADMIN_SECRET}&priority=1`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl: `https://${domain}`, email: `info@${domain}` }),
        signal: AbortSignal.timeout(10000),
      });
      const text = await resp.text();
      if (text.startsWith("<")) { await new Promise(r => setTimeout(r, 15000)); continue; }
      const data = JSON.parse(text);
      if (data.tenantId) return data.tenantId;
      if (data.error?.includes("already exists")) {
        const tid = data.tenantId || domain.replace(/[^a-zA-Z0-9]/g, "_");
        // Force rescrape - works even if paused, sets status to scraping + fills siteUrl
        const rr = await fetch(`${BASE_URL}/api/admin/rescrape/${tid}?secret=${ADMIN_SECRET}&priority=1&siteUrl=${encodeURIComponent("https://" + domain)}`, {
          method: "POST", signal: AbortSignal.timeout(5000),
        }).catch(() => null);
        if (rr) console.log(`  [rescrape] ${tid} triggered`);
        return tid;
      }
      return null;
    } catch { if (attempt < 3) await new Promise(r => setTimeout(r, 15000)); }
  }
  return null;
}

async function waitForScrape(domain: string): Promise<{ ready: boolean; tenantId?: string }> {
  const start = Date.now();
  while (true) {
    try {
      const resp = await fetch(`${BASE_URL}/api/admin/tenants?secret=${ADMIN_SECRET}`, { signal: AbortSignal.timeout(10000) });
      if (!resp.ok) { await new Promise(r => setTimeout(r, 5000)); continue; }
      const text = await resp.text();
      if (text.startsWith("<")) { await new Promise(r => setTimeout(r, 5000)); continue; }
      const tenants = JSON.parse(text) as any[];
      const t = tenants.find((x: any) => x.domain === domain);
      if (t && t.status === "active" && t.chunksCount > 0) { console.log(); return { ready: true, tenantId: t.id }; }
      if (t && (t.status === "error" || t.status === "failed")) { console.log(); return { ready: false }; }
      // If still paused, re-trigger rescrape
      if (t && t.status === "paused") {
        await fetch(`${BASE_URL}/api/admin/rescrape/${t.id}?secret=${ADMIN_SECRET}&priority=1&siteUrl=${encodeURIComponent("https://" + domain)}`, {
          method: "POST", signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
      process.stdout.write(`\r  [scrape] Waiting for ${domain}... ${Math.round((Date.now() - start) / 1000)}s`);
    } catch {}
    await new Promise(r => setTimeout(r, 10000));
  }
}

async function getUnsubSet(): Promise<Set<string>> {
  try {
    const resp = await fetch(`${BASE_URL}/api/admin/unsubscribed?secret=${ADMIN_SECRET}`);
    if (!resp.ok) return new Set();
    return new Set(((await resp.json()) as string[]).map(e => e.toLowerCase()));
  } catch { return new Set(); }
}

// --- Email ---
const tpls = ["clean", "gaps", "personal"];

function buildEmail(p: Prospect, demoUrl: string, template: string): { subject: string; html: string } {
  const unsub = `<p style="font-size:11px;color:#999;"><a href="${BASE_URL}/unsubscribe?email=${encodeURIComponent(p.email)}" style="color:#999;">${p.lang === "pl" ? "Wypisz się" : "Unsubscribe"}</a></p>`;
  const sig = `<p>Jakub<br>whisp.so</p>`;
  const cta = p.lang === "pl"
    ? `<p>Widget można ustawić na Twojej stronie w jeden dzień - wrzucam link do <a href="${BASE_URL}/book">kalendarza</a>.</p>`
    : `<p>I can have this running on your site by tomorrow - you can reply here or <a href="${BASE_URL}/book">book a call</a> with me to discuss it in details.</p>`;
  const hi = p.lang === "pl" ? `Cześć ${p.firstName},` : `Hi ${p.firstName},`;

  const subjects: Record<string, Record<string, string>> = {
    clean: { pl: `Zbudowałem darmowego asystenta AI dla ${p.domain}`, en: `I built a free AI assistant for ${p.domain}` },
    gaps: { pl: `Przetestowałem ${p.domain} z perspektywy klienta`, en: `I tested ${p.domain} from a customer's perspective` },
    personal: { pl: `Mogę pomóc ${p.domain} z AI?`, en: `Can I help ${p.domain} with AI?` },
  };

  const bodies: Record<string, Record<string, string>> = {
    clean: {
      pl: `<p>${hi}</p><p>Zbudowałem asystenta AI, który czyta ${p.domain} i odpowiada na pytania odwiedzających - usługi, cennik, lokalizacja, godziny otwarcia, wszystko co jest na stronie.</p><p>Już zna Twoją stronę. Możesz go wypróbować tutaj:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
      en: `<p>${hi}</p><p>I built an AI assistant that reads ${p.domain} and answers visitor questions - pricing, services, location, hours, anything on your site.</p><p>It already knows your website. You can try it here:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    },
    gaps: {
      pl: `<p>${hi}</p><p>Zbudowałem AI, który czyta Twoją stronę i odpowiada na pytania odwiedzających. Przetestowałem go na ${p.domain} - większość odpowiedzi była dobra, ale kilka typowych pytań zostawiło odwiedzających bez jasnej odpowiedzi.</p><p>Zobacz co wie i czego mu brakuje:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
      en: `<p>${hi}</p><p>I built an AI that reads your website and answers visitor questions. I tested it on ${p.domain} - most questions got good answers, but a few common ones left visitors without a clear next step.</p><p>You can see exactly what it knows and what's missing:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    },
    personal: {
      pl: `<p>${hi}</p><p>Jestem Jakub, studiuję informatykę w Polsce i pomagam firmom wdrażać AI żeby rosły. Zbudowałem asystenta AI, który czyta Twoją stronę i odpowiada na pytania klientów 24/7.</p><p>Już zrobiłem jednego dla ${p.domain} - zna Twoje usługi, cennik i wszystko co jest na stronie:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
      en: `<p>${hi}</p><p>I'm Jakub, I study Computer Science in Poland and I'm helping businesses onboard AI to grow. I built an AI assistant that reads your website and can answer customer questions 24/7.</p><p>I already made one for ${p.domain} - it knows your services, pricing, and everything on your site:<br><a href="${demoUrl}">${demoUrl}</a></p>${cta}${sig}${unsub}`,
    },
  };

  return { subject: subjects[template][p.lang], html: bodies[template][p.lang] };
}

async function sendEmail(p: Prospect, demoUrl: string, template: string): Promise<"sent" | "quota" | "fail"> {
  const { subject, html } = buildEmail(p, demoUrl, template);
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
    return "fail";
  } catch { return "fail"; }
}

async function sendToProspect(p: Prospect): Promise<"sent" | "quota" | "skip"> {
  if (alreadySent(p.email) || domainSent(p.domain)) return "skip";
  const unsubSet = await getUnsubSet();
  if (unsubSet.has(p.email.toLowerCase())) return "skip";

  // Register + priority scrape
  console.log(`  [register] ${p.domain}...`);
  const tid = await registerTenant(p.domain);
  if (!tid) { console.log("  Skip - registration failed"); return "skip"; }

  // Wait for scrape - no timeout
  console.log(`  [scrape] Waiting for ${p.domain}...`);
  const { ready, tenantId } = await waitForScrape(p.domain);
  if (!ready) { console.log(`  Skip - scrape failed for ${p.domain}`); return "skip"; }

  // Send
  const template = tpls[state.totalSent % 3];
  const demoUrl = `${BASE_URL}/demo/${tenantId}`;

  if (!SEND) {
    console.log(`  [DRY] [${template}] [${p.lang}] ${p.firstName} <${p.email}> @ ${p.domain}`);
    state.totalSent++;
    saveState();
    return "sent";
  }

  const result = await sendEmail(p, demoUrl, template);
  if (result === "sent") {
    markSent(p.email, template);
    state.totalSent++;
    saveState();
    console.log(`  ✉️  [${template}] [${p.lang}] ${p.firstName} <${p.email}> @ ${p.domain}`);
    return "sent";
  } else if (result === "quota") {
    state.quotaHitAt = new Date().toISOString();
    saveState();
    console.log("  QUOTA HIT");
    return "quota";
  }
  return "skip";
}

// --- Main ---
async function main() {
  console.log("=== SYNCHRONOUS OUTREACH LOOP ===");
  console.log(`${SEND ? "SENDING" : "DRY RUN"} | Sent: ${state.totalSent} | Enriched: ${state.totalEnriched} | Pending: ${state.pending.length}\n`);

  // Reset quota if new day
  if (state.quotaHitAt && new Date(state.quotaHitAt).toDateString() !== new Date().toDateString()) {
    state.quotaHitAt = null;
    saveState();
    console.log("New day - quota reset!\n");
  }

  // Phase 1: Drain pending queue (from previous hybrid runs)
  if (state.pending.length > 0) {
    console.log(`--- DRAINING ${state.pending.length} PENDING ---`);
    const stillPending: Prospect[] = [];

    for (const p of state.pending) {
      if (state.quotaHitAt) { stillPending.push(p); continue; }
      const result = await sendToProspect(p);
      if (result === "quota") { stillPending.push(p); }
    }

    state.pending = stillPending;
    saveState();
    console.log(`Done draining. ${stillPending.length} still pending.\n`);
  }

  // Phase 2: Synchronous find-enrich-scrape-send loop
  console.log("--- SYNCHRONOUS LOOP ---");
  while (true) {
    // Quota check
    if (state.quotaHitAt) {
      if (new Date(state.quotaHitAt).toDateString() === new Date().toDateString()) {
        console.log("\nQuota hit today. Waiting 1 hour...");
        await new Promise(r => setTimeout(r, 3600000));
        if (new Date(state.quotaHitAt!).toDateString() !== new Date().toDateString()) {
          state.quotaHitAt = null;
          saveState();
          console.log("New day - resuming!\n");
        }
        continue;
      }
      state.quotaHitAt = null;
      saveState();
    }

    // Find next valid prospect
    let prospect: Prospect | null = null;
    for (let attempts = 0; attempts < 50; attempts++) {
      const candidate = await getNextCandidate();
      if (!candidate) { state.keywordOffset++; state.apolloPage = 1; state.apolloIndex = 0; cachedPage = []; saveState(); continue; }
      if (!candidate.has_email || !candidate.organization?.name) continue;

      console.log(`\n[${state.totalSent + 1}] Enriching ${candidate.first_name} @ ${candidate.organization.name}...`);
      const enriched = await enrichPerson(candidate.id);
      state.totalEnriched++;
      const ep = enriched.person;
      if (!ep?.email || !ep?.organization?.primary_domain) { console.log("  Skip - no email/domain"); continue; }

      const domain = ep.organization.primary_domain;
      if (alreadySent(ep.email) || domainSent(domain)) { console.log(`  Skip - already contacted ${domain}`); continue; }
      if (domain.includes("linkedin.com") || domain.includes("facebook.com")) continue;

      prospect = {
        firstName: ep.first_name, email: ep.email, domain,
        orgName: ep.organization.name, title: ep.title,
        country: ep.country || "Unknown",
        lang: detectLang(ep.country || "", domain),
      };
      console.log(`  Found: ${prospect.firstName} <${prospect.email}> @ ${domain} [${prospect.lang}]`);
      break;
    }

    if (!prospect) { console.log("No more prospects found. Rotating keywords..."); continue; }

    // Register, scrape, send - all synchronous
    const result = await sendToProspect(prospect);
    if (result === "quota") continue;

    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(console.error);
