/**
 * Outreach loop - two interleaved phases every cycle:
 *
 *   Phase 1: SEND - check all pending prospects, send to any that are scraped
 *   Phase 2: FIND - enrich a few new prospects, register with priority
 *
 * This way we're always sending to freshly scraped domains AND finding new ones.
 * No blocking waits. No timeouts. Just check and send what's ready.
 *
 * Usage:
 *   APOLLO_API_KEY=xxx RESEND_API_KEY=xxx npx tsx scripts/outreach-loop.ts
 *   APOLLO_API_KEY=xxx RESEND_API_KEY=xxx npx tsx scripts/outreach-loop.ts --dry-run
 *   APOLLO_API_KEY=xxx RESEND_API_KEY=xxx npx tsx scripts/outreach-loop.ts --find=10 --pause=60
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
const FIND_PER_CYCLE = parseInt(process.argv.find(a => a.startsWith("--find="))?.split("=")[1] || "5");
const PAUSE_SECONDS = parseInt(process.argv.find(a => a.startsWith("--pause="))?.split("=")[1] || "60");

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

interface Prospect {
  firstName: string;
  email: string;
  domain: string;
  orgName: string;
  title: string;
  country: string;
  lang: "pl" | "en";
}

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
function domainSent(domain: string): boolean {
  return Object.keys(sentLog).some(e => e.endsWith("@" + domain) || e.endsWith("." + domain));
}
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
  if (resp.status === 429) {
    console.log("  [apollo] Rate limited - waiting 60s");
    await new Promise(r => setTimeout(r, 60000));
    return fetchPage();
  }
  if (!resp.ok) throw new Error(`Apollo ${resp.status}`);
  const data = await resp.json();
  console.log(`  [apollo] ${data.people?.length || 0} results (${data.total_entries} total)`);
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
      console.log(`  [apollo] Rotating keywords (offset ${state.keywordOffset})`);
      if (state.keywordOffset > ALL_KEYWORDS.length / 15) {
        state.keywordOffset = 0;
      }
      cachedPage = await fetchPage();
      if (cachedPage.length === 0) return null;
    }
  }
  const person = cachedPage[state.apolloIndex];
  state.apolloIndex++;
  return person;
}

async function enrichPerson(id: string): Promise<any> {
  const resp = await fetch("https://api.apollo.io/api/v1/people/match", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    body: JSON.stringify({ id }),
    signal: AbortSignal.timeout(10000),
  });
  if (resp.status === 429) {
    console.log("  [apollo] Rate limited - waiting 60s");
    await new Promise(r => setTimeout(r, 60000));
    return enrichPerson(id);
  }
  if (!resp.ok) return { person: null };
  return resp.json();
}

// --- Whisp ---
async function fetchTenantsMap(): Promise<Map<string, any>> {
  try {
    const resp = await fetch(`${BASE_URL}/api/admin/tenants?secret=${ADMIN_SECRET}`, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) return new Map();
    const text = await resp.text();
    if (text.startsWith("<")) return new Map();
    return new Map((JSON.parse(text) as any[]).map(t => [t.domain, t]));
  } catch { return new Map(); }
}

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
      if (text.startsWith("<")) {
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }
      const data = JSON.parse(text);
      if (data.tenantId) return data.tenantId;
      if (data.error?.includes("already exists")) {
        const tid = data.tenantId || domain.replace(/[^a-zA-Z0-9]/g, "_");
        await fetch(`${BASE_URL}/api/admin/rescrape/${tid}?secret=${ADMIN_SECRET}&priority=1&siteUrl=${encodeURIComponent("https://" + domain)}`, {
          method: "POST", signal: AbortSignal.timeout(5000),
        }).catch(() => {});
        return tid;
      }
      return null;
    } catch {
      if (attempt < 3) await new Promise(r => setTimeout(r, 15000));
    }
  }
  return null;
}

async function getUnsubSet(): Promise<Set<string>> {
  try {
    const resp = await fetch(`${BASE_URL}/api/admin/unsubscribed?secret=${ADMIN_SECRET}`);
    if (!resp.ok) return new Set();
    return new Set(((await resp.json()) as string[]).map(e => e.toLowerCase()));
  } catch { return new Set(); }
}

// --- Email ---
const templates = ["clean", "gaps", "personal"];

function buildEmail(p: Prospect, demoUrl: string, template: string): { subject: string; html: string } {
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

async function sendOne(p: Prospect, demoUrl: string, template: string): Promise<"sent" | "quota" | "fail"> {
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

// --- Main loop ---
async function cycle() {
  const now = new Date();
  console.log(`\n--- CYCLE @ ${now.toISOString().slice(11, 19)} | sent=${state.totalSent} enriched=${state.totalEnriched} pending=${state.pending.length} ---`);

  // Check quota reset
  if (state.quotaHitAt) {
    if (new Date(state.quotaHitAt).toDateString() === now.toDateString()) {
      console.log("  Quota hit today - waiting");
      return;
    }
    state.quotaHitAt = null;
    console.log("  New day - quota reset!");
  }

  const tenantMap = await fetchTenantsMap();
  const unsubSet = await getUnsubSet();
  let quotaHit = false;

  // PHASE 1: Send to any pending prospects that are now ready
  if (state.pending.length > 0) {
    const stillPending: Prospect[] = [];
    let sentThisPhase = 0;

    for (const p of state.pending) {
      if (quotaHit) { stillPending.push(p); continue; }
      if (alreadySent(p.email) || domainSent(p.domain)) continue;
      if (unsubSet.has(p.email.toLowerCase())) continue;

      const tenant = tenantMap.get(p.domain);
      if (!tenant || tenant.status !== "active" || !tenant.chunksCount) {
        stillPending.push(p);
        continue;
      }

      const template = templates[state.totalSent % 3];
      const demoUrl = `${BASE_URL}/demo/${tenant.id}`;

      if (!SEND) {
        console.log(`  [DRY] [${template}] [${p.lang}] ${p.firstName} <${p.email}> @ ${p.domain}`);
        state.totalSent++;
        sentThisPhase++;
        continue;
      }

      const result = await sendOne(p, demoUrl, template);
      if (result === "sent") {
        markSent(p.email, template);
        state.totalSent++;
        sentThisPhase++;
        console.log(`  ✉️  [${template}] [${p.lang}] ${p.firstName} <${p.email}> @ ${p.domain}`);
      } else if (result === "quota") {
        quotaHit = true;
        state.quotaHitAt = now.toISOString();
        stillPending.push(p);
        console.log("  QUOTA HIT");
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    state.pending = stillPending;
    if (sentThisPhase > 0) console.log(`  Sent ${sentThisPhase} pending`);
  }

  // PHASE 2: Find new prospects (skip if quota hit)
  if (!quotaHit) {
    let found = 0;
    const seenDomains = new Set(state.pending.map(p => p.domain));

    for (let i = 0; i < FIND_PER_CYCLE * 3 && found < FIND_PER_CYCLE; i++) {
      const candidate = await getNextCandidate();
      if (!candidate) break;
      if (!candidate.has_email || !candidate.organization?.name) continue;

      const enriched = await enrichPerson(candidate.id);
      state.totalEnriched++;
      const ep = enriched.person;
      if (!ep?.email || !ep?.organization?.primary_domain) continue;

      const domain = ep.organization.primary_domain;
      const email = ep.email;
      if (alreadySent(email) || domainSent(domain)) continue;
      if (seenDomains.has(domain)) continue;
      if (domain.includes("linkedin.com") || domain.includes("facebook.com")) continue;
      seenDomains.add(domain);

      const country = ep.country || "Unknown";
      const prospect: Prospect = {
        firstName: ep.first_name,
        email,
        domain,
        orgName: ep.organization.name,
        title: ep.title,
        country,
        lang: detectLang(country, domain),
      };

      // Register with priority
      const tid = await registerTenant(domain);

      // Check if already scraped - send immediately
      const tenant = tenantMap.get(domain);
      if (tenant && tenant.status === "active" && tenant.chunksCount > 0 && !quotaHit) {
        const template = templates[state.totalSent % 3];
        const demoUrl = `${BASE_URL}/demo/${tenant.id}`;
        if (!SEND) {
          console.log(`  [DRY] [${template}] [${prospect.lang}] ${prospect.firstName} <${email}> @ ${domain}`);
          state.totalSent++;
        } else {
          const result = await sendOne(prospect, demoUrl, template);
          if (result === "sent") {
            markSent(email, template);
            state.totalSent++;
            console.log(`  ✉️  [${template}] [${prospect.lang}] ${prospect.firstName} <${email}> @ ${domain}`);
          } else if (result === "quota") {
            quotaHit = true;
            state.quotaHitAt = now.toISOString();
            state.pending.push(prospect);
          }
        }
      } else {
        state.pending.push(prospect);
        console.log(`  ⏳ ${prospect.firstName} <${email}> @ ${domain} (queued)`);
      }

      found++;
      await new Promise(r => setTimeout(r, 300));
    }

    if (found > 0) console.log(`  Found ${found} new prospects`);
  }

  saveState();
}

async function main() {
  console.log("=== OUTREACH LOOP ===");
  console.log(`${SEND ? "SENDING" : "DRY RUN"} | Find ${FIND_PER_CYCLE}/cycle | Pause ${PAUSE_SECONDS}s`);
  console.log(`Sent log: ${Object.keys(sentLog).length} | Pending: ${state.pending.length}\n`);

  while (true) {
    try {
      await cycle();
    } catch (err) {
      console.error(`Cycle error: ${err}`);
    }

    const pauseMs = (state.quotaHitAt && new Date(state.quotaHitAt).toDateString() === new Date().toDateString())
      ? 3600000
      : PAUSE_SECONDS * 1000;

    await new Promise(r => setTimeout(r, pauseMs));
  }
}

main().catch(console.error);
