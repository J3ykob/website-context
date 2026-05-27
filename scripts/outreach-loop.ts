/**
 * Continuous outreach loop — runs forever, finding new prospects and emailing them.
 *
 * Cycle:
 *   1. Search Apollo for small business owners (no industry filter)
 *   2. Dedup against sent log + existing tenants
 *   3. Enrich to get verified emails + domains
 *   4. Register domains on Whisp
 *   5. Send emails to ready tenants (already scraped)
 *   6. Sleep, then repeat — newly scraped tenants get emailed next cycle
 *
 * Stops at Resend daily quota (100 on free, 50k on paid).
 * Resumes next day automatically.
 *
 * Usage:
 *   APOLLO_API_KEY=xxx RESEND_API_KEY=xxx npx tsx scripts/outreach-loop.ts
 *   APOLLO_API_KEY=xxx RESEND_API_KEY=xxx npx tsx scripts/outreach-loop.ts --batch=50 --pause=300
 *   APOLLO_API_KEY=xxx RESEND_API_KEY=xxx npx tsx scripts/outreach-loop.ts --dry-run
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
const SEND = !process.argv.includes("--dry-run");
const BATCH_SIZE = parseInt(process.argv.find(a => a.startsWith("--batch="))?.split("=")[1] || "25");
const PAUSE_SECONDS = parseInt(process.argv.find(a => a.startsWith("--pause="))?.split("=")[1] || "600");

if (!APOLLO_KEY) { console.error("APOLLO_API_KEY required"); process.exit(1); }
if (!RESEND_KEY && SEND) { console.error("RESEND_API_KEY required for sending"); process.exit(1); }

const EU_COUNTRIES = ["Poland", "United Kingdom", "Germany", "France", "Italy", "Spain", "Netherlands", "Sweden", "Portugal", "Belgium", "Austria", "Czech Republic", "Denmark", "Norway", "Ireland"];
const PL_PATTERNS = ["poland", ".pl"];

// --- Persistent state ---
const SENT_LOG_PATH = resolve(__dirname, "../data/pipeline-sent.json");
const STATE_PATH = resolve(__dirname, "../data/outreach-state.json");

interface SentEntry { sentAt: string; template: string }
let sentLog: Record<string, SentEntry> = {};
try { sentLog = JSON.parse(readFileSync(SENT_LOG_PATH, "utf-8")); } catch {}

interface LoopState {
  apolloPage: number;
  totalEnriched: number;
  totalSent: number;
  totalRegistered: number;
  quotaHitAt: string | null;
  pendingProspects: Prospect[];
}

let state: LoopState = { apolloPage: 1, totalEnriched: 0, totalSent: 0, totalRegistered: 0, quotaHitAt: null, pendingProspects: [] };
try { state = JSON.parse(readFileSync(STATE_PATH, "utf-8")); } catch {}

function saveState() { writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); }
function saveSentLog() { writeFileSync(SENT_LOG_PATH, JSON.stringify(sentLog, null, 2)); }

function alreadySent(email: string): boolean { return email.toLowerCase() in sentLog; }
function markSent(email: string, template: string) {
  sentLog[email.toLowerCase()] = { sentAt: new Date().toISOString(), template };
  saveSentLog();
}

function detectLang(country: string, domain: string): "pl" | "en" {
  const lower = (country + " " + domain).toLowerCase();
  return PL_PATTERNS.some(p => lower.includes(p)) ? "pl" : "en";
}

interface Prospect {
  firstName: string;
  email: string;
  domain: string;
  orgName: string;
  title: string;
  country: string;
  lang: "pl" | "en";
}

// --- Apollo ---
async function searchApollo(page: number): Promise<{ people: any[]; total: number }> {
  const resp = await fetch("https://api.apollo.io/api/v1/mixed_people/api_search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    body: JSON.stringify({
      organization_locations: EU_COUNTRIES,
      organization_num_employees_ranges: ["1,50"],
      person_seniorities: ["owner", "founder", "c_suite"],
      contact_email_status: ["verified"],
      page,
      per_page: 100,
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (resp.status === 429) {
    console.log("  [apollo] Rate limit — waiting 60s");
    await new Promise(r => setTimeout(r, 60000));
    return searchApollo(page);
  }
  if (!resp.ok) throw new Error(`Apollo ${resp.status}`);
  const data = await resp.json();
  return { people: data.people || [], total: data.total_entries || 0 };
}

async function enrichPerson(id: string): Promise<any> {
  const resp = await fetch("https://api.apollo.io/api/v1/people/match", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Api-Key": APOLLO_KEY },
    body: JSON.stringify({ id }),
    signal: AbortSignal.timeout(10000),
  });
  if (resp.status === 429) {
    console.log("  [apollo] Rate limit — waiting 60s");
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

async function getUnsubSet(): Promise<Set<string>> {
  try {
    const resp = await fetch(`${BASE_URL}/api/admin/unsubscribed?secret=${ADMIN_SECRET}`);
    if (!resp.ok) return new Set();
    return new Set(((await resp.json()) as string[]).map(e => e.toLowerCase()));
  } catch { return new Set(); }
}

// --- Email ---
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
  console.log(`\n${"=".repeat(60)}`);
  console.log(`CYCLE @ ${now.toISOString()}`);
  console.log(`State: page=${state.apolloPage} enriched=${state.totalEnriched} sent=${state.totalSent} pending=${state.pendingProspects.length}`);

  // Check if quota was hit today — skip finding new prospects, just try sending pending
  if (state.quotaHitAt) {
    const hitDate = new Date(state.quotaHitAt).toDateString();
    if (hitDate === now.toDateString()) {
      console.log(`Quota hit earlier today — only retrying pending sends`);
    } else {
      console.log(`New day — resetting quota flag`);
      state.quotaHitAt = null;
      saveState();
    }
  }

  const templates = ["clean", "gaps", "personal"];
  const tenantMap = await fetchTenantsMap();
  const unsubSet = await getUnsubSet();
  let sentThisCycle = 0;
  let quotaHit = false;

  // Phase 1: Try sending pending prospects (from previous cycles)
  if (state.pendingProspects.length > 0) {
    console.log(`\n--- Sending ${state.pendingProspects.length} pending prospects ---`);
    const stillPending: Prospect[] = [];

    for (const p of state.pendingProspects) {
      if (quotaHit) { stillPending.push(p); continue; }
      if (alreadySent(p.email)) continue;
      if (unsubSet.has(p.email.toLowerCase())) continue;

      const tenant = tenantMap.get(p.domain);
      if (!tenant || tenant.status !== "active" || !tenant.chunksCount) {
        stillPending.push(p);
        continue;
      }

      const template = templates[state.totalSent % 3];
      const demoUrl = `${BASE_URL}/demo/${tenant.id}`;

      if (!SEND) {
        console.log(`  [DRY] ${p.firstName} <${p.email}> @ ${p.domain}`);
        sentThisCycle++;
        state.totalSent++;
        continue;
      }

      const result = await sendOne(p, demoUrl, template);
      if (result === "sent") {
        markSent(p.email, template);
        sentThisCycle++;
        state.totalSent++;
        console.log(`  ✉️  [${template}] ${p.firstName} <${p.email}> @ ${p.domain}`);
      } else if (result === "quota") {
        quotaHit = true;
        state.quotaHitAt = now.toISOString();
        stillPending.push(p);
        console.log(`  QUOTA — stopping sends`);
      }
      await new Promise(r => setTimeout(r, 1000));
    }

    state.pendingProspects = stillPending;
    saveState();
  }

  // Phase 2: Find new prospects (skip if quota hit)
  if (!quotaHit && !state.quotaHitAt) {
    console.log(`\n--- Finding ${BATCH_SIZE} new prospects (Apollo page ${state.apolloPage}) ---`);
    const seenDomains = new Set([...tenantMap.keys(), ...state.pendingProspects.map(p => p.domain)]);
    const seenOrgs = new Set<string>();
    let found = 0;

    const { people, total } = await searchApollo(state.apolloPage);
    console.log(`  Apollo: ${people.length} results (${total} total)`);

    for (const person of people) {
      if (found >= BATCH_SIZE) break;
      if (!person.has_email) continue;
      const orgName = person.organization?.name;
      if (!orgName || seenOrgs.has(orgName)) continue;
      seenOrgs.add(orgName);

      const enriched = await enrichPerson(person.id);
      state.totalEnriched++;
      const ep = enriched.person;

      if (!ep?.email || !ep?.organization?.primary_domain) continue;
      if (alreadySent(ep.email)) continue;
      if (ep.organization.primary_domain.includes("linkedin.com")) continue;

      const domain = ep.organization.primary_domain;
      if (seenDomains.has(domain)) continue;
      seenDomains.add(domain);

      const country = ep.country || "Unknown";
      const prospect: Prospect = {
        firstName: ep.first_name,
        email: ep.email,
        domain,
        orgName: ep.organization.name,
        title: ep.title,
        country,
        lang: detectLang(country, domain),
      };

      // Register domain
      const tid = await registerTenant(domain);
      if (tid) state.totalRegistered++;

      // Try sending immediately if tenant is ready
      const tenant = tenantMap.get(domain);
      if (tenant && tenant.status === "active" && tenant.chunksCount > 0 && !quotaHit) {
        const template = templates[state.totalSent % 3];
        const demoUrl = `${BASE_URL}/demo/${tenant.id}`;

        if (!SEND) {
          console.log(`  [DRY] ${prospect.firstName} <${prospect.email}> @ ${domain}`);
          sentThisCycle++;
          state.totalSent++;
        } else {
          const result = await sendOne(prospect, demoUrl, template);
          if (result === "sent") {
            markSent(prospect.email, template);
            sentThisCycle++;
            state.totalSent++;
            console.log(`  ✉️  [${template}] ${prospect.firstName} <${prospect.email}> @ ${domain}`);
          } else if (result === "quota") {
            quotaHit = true;
            state.quotaHitAt = now.toISOString();
            state.pendingProspects.push(prospect);
            console.log(`  QUOTA — queuing rest`);
          }
        }
      } else {
        state.pendingProspects.push(prospect);
        console.log(`  ⏳ ${prospect.firstName} <${prospect.email}> @ ${domain} (scraping)`);
      }

      found++;
      await new Promise(r => setTimeout(r, 300));
    }

    state.apolloPage++;
    if (state.apolloPage > 500) state.apolloPage = 1; // wrap around
    saveState();

    console.log(`  Found: ${found} | Sent: ${sentThisCycle} | Pending: ${state.pendingProspects.length}`);
  }

  console.log(`\nCycle done. Total all-time: ${state.totalSent} sent, ${state.totalEnriched} enriched, ${state.totalRegistered} registered`);
  console.log(`Pending queue: ${state.pendingProspects.length}`);
}

async function loop() {
  console.log("Outreach loop started");
  console.log(`Batch: ${BATCH_SIZE} | Pause: ${PAUSE_SECONDS}s | ${SEND ? "SENDING" : "DRY RUN"}`);
  console.log(`Sent log: ${Object.keys(sentLog).length} previous sends\n`);

  while (true) {
    try {
      await cycle();
    } catch (err) {
      console.error(`Cycle error: ${err}`);
    }

    const pauseMs = (state.quotaHitAt && new Date(state.quotaHitAt).toDateString() === new Date().toDateString())
      ? 3600000  // quota hit: check every hour for new day
      : PAUSE_SECONDS * 1000;

    console.log(`Sleeping ${Math.round(pauseMs / 1000)}s...`);
    await new Promise(r => setTimeout(r, pauseMs));
  }
}

loop().catch(console.error);
