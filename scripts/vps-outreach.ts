/**
 * VPS-native outreach loop - scrapes directly, no Render dependency.
 *
 * Find one -> enrich -> scrape locally -> send -> repeat
 *
 * Scraping uses BGE on localhost (fast), Qdrant remote, Browserless cloud.
 * Whisp.so (Render) is only used for demo links and the tenant registry.
 *
 * Usage:
 *   source /opt/whisp-outreach/.env && npx tsx scripts/vps-outreach.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { scrapeTenant } from "../src/multi-tenant/scrape-pipeline.js";
import { closeBrowser } from "../src/scraper/index.js";
import { uploadTenantFiles } from "../src/storage/r2.js";
import { recordProspect } from "../src/analytics/d1.js";

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
const DATA_DIR = resolve(__dirname, "../data");
if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
const SENT_LOG_PATH = resolve(DATA_DIR, "pipeline-sent.json");
const STATE_PATH = resolve(DATA_DIR, "outreach-state.json");

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
  // Pick 15 random keywords each time for maximum diversity
  const shuffled = [...ALL_KEYWORDS].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, 15);
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

// --- Local scraping ---
async function scrapeLocally(tenantId: string, domain: string): Promise<{ success: boolean; chunks: number; pages: number }> {
  const siteUrl = `https://${domain}`;
  try {
    console.log(`  [scrape] Scraping ${domain} locally...`);
    // Up to 100 pages — large sites (many brand/listing pages) were missing their
    // contact/about/pricing pages. Key pages are crawled first (see crawler), and the
    // crawl still stops early when the queue empties + is bounded by maxDepth, so
    // small sites are unaffected; only sites that NEED more pages get them.
    const result = await scrapeTenant(tenantId, siteUrl, 100);
    await closeBrowser();
    if (result.chunks === 0) {
      console.log(`  [scrape] 0 chunks - site might be JS-rendered or empty`);
      return { success: false, chunks: 0, pages: 0 };
    }
    console.log(`  [scrape] Done: ${result.pages} pages, ${result.chunks} chunks`);
    // Upload to R2 — context-meta.json is MANDATORY (serving self-heals from it;
    // uploadTenantFiles throws if it didn't land, caught below -> no email).
    console.log(`  [r2] Uploading to R2...`);
    const up = await uploadTenantFiles(tenantId, resolve(__dirname, "../data"), ["context-meta.json"]);
    console.log(`  [r2] uploaded: ${up.uploaded.join(", ") || "none"}${up.failed.length ? ` | FAILED: ${up.failed.join(", ")}` : ""}`);
    // The hero screenshot must be present too — emailing a demo whose hero image
    // 404s degrades the prospect's one-shot first impression. Skip rather than send.
    if (!up.uploaded.includes("screenshot.png")) {
      console.log(`  [r2] no screenshot for ${domain} - NOT emailing (would show a broken hero image).`);
      return { success: false, chunks: result.chunks, pages: result.pages };
    }

    // Register/activate on Render (retried). If this fails (e.g. a transient
    // Render outage / deploy), the demo still self-heals from R2 on first visit,
    // so we don't hard-block the email on it — the R2 upload above is the gate.
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const r = await fetch(`${BASE_URL}/api/admin/update-tenant/${tenantId}?secret=${ADMIN_SECRET}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ status: "active", chunksCount: result.chunks, pagesCount: result.pages, domain, siteUrl }),
          signal: AbortSignal.timeout(10000),
        });
        if (r.ok) break;
        console.log(`  [sync] Render update attempt ${attempt}: HTTP ${r.status}`);
      } catch (e: any) { console.log(`  [sync] Render update attempt ${attempt} failed: ${e.message}`); }
      if (attempt < 3) await new Promise((res) => setTimeout(res, 5000));
    }
    return { success: true, chunks: result.chunks, pages: result.pages };
  } catch (err: any) {
    await closeBrowser();
    console.log(`  [scrape] Failed: ${err.message}`);
    return { success: false, chunks: 0 };
  }
}

// --- Register on Render (for demo pages to work) ---
async function registerOnRender(domain: string): Promise<string | null> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(`${BASE_URL}/api/tenants?secret=${ADMIN_SECRET}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ siteUrl: `https://${domain}`, email: `info@${domain}` }),
        signal: AbortSignal.timeout(10000),
      });
      const text = await resp.text();
      if (text.startsWith("<")) { await new Promise(r => setTimeout(r, 10000)); continue; }
      const data = JSON.parse(text);
      return data.tenantId || (data.error?.includes("already exists") ? data.tenantId || domain.replace(/[^a-zA-Z0-9]/g, "_") : null);
    } catch { if (attempt < 2) await new Promise(r => setTimeout(r, 10000)); }
  }
  return domain.replace(/[^a-zA-Z0-9]/g, "_");
}

// --- Email templates ---
// All new strategies: curiosity, problem, niche, pricing, warm
const NEW_TEMPLATES = [
  "curiosity",      // Quick question about {domain}
  "problem",        // Your visitors have questions
  "niche_hotel",    // Guests asking at 2am
  "niche_restaurant", // Visitors want to book
  "niche_law",      // Potential clients leave without calling
  "pricing",        // $14.99 one-time
  "warm",           // Love what you're doing
];

const NICHE_MAP: Record<string, string> = {
  hotel: "niche_hotel", hospitality: "niche_hotel", "bed and breakfast": "niche_hotel",
  restaurant: "niche_restaurant", cafe: "niche_restaurant", dining: "niche_restaurant", catering: "niche_restaurant",
  "law firm": "niche_law", "legal services": "niche_law", solicitors: "niche_law", law: "niche_law",
};

function pickTemplate(industry: string): string {
  // Check if there's a niche template for this industry
  const niche = NICHE_MAP[industry?.toLowerCase() || ""];
  if (niche && Math.random() < 0.3) return niche; // 30% chance of niche template

  // Otherwise rotate through general templates
  const general = ["curiosity", "problem", "pricing", "warm"];
  return general[Math.floor(Math.random() * general.length)];
}

function buildEmail(p: Prospect & { industry?: string }, demoUrl: string, template: string): { subject: string; html: string } {
  const unsub = `<p style="font-size:11px;color:#999;"><a href="${BASE_URL}/unsubscribe?email=${encodeURIComponent(p.email)}" style="color:#999;">${p.lang === "pl" ? "Wypisz sie" : "Unsubscribe"}</a></p>`;
  const sig = `<p>Jakub<br>whisp.so</p>`;
  const hi = `Hi ${p.firstName},`;
  const link = `<a href="${demoUrl}">${demoUrl}</a>`;

  const templates: Record<string, { subject: string; body: string }> = {
    curiosity: {
      subject: `Quick question about ${p.domain}`,
      body: `<p>${hi}</p><p>I was looking at ${p.domain} and had a question - do your visitors ever leave without finding what they need?</p><p>I built something that might help. It's an AI that reads your entire website and answers visitor questions 24/7:</p><p>${link}</p><p>It's $14.99 one-time to set it up on your site. No subscription, no hidden fees.</p>${sig}${unsub}`,
    },
    problem: {
      subject: `${p.firstName}, your website visitors have questions`,
      body: `<p>${hi}</p><p>Most websites lose visitors who can't find answers fast enough. Phone's not always available, contact forms take days.</p><p>I built an AI assistant for ${p.domain} that answers instantly - pricing, services, hours, anything on your site:</p><p>${link}</p><p>$14.99 one-time setup. No subscription, no monthly fees.</p>${sig}${unsub}`,
    },
    pricing: {
      subject: `AI assistant for ${p.domain} - $14.99 one-time`,
      body: `<p>${hi}</p><p>I built an AI assistant that reads ${p.domain} and answers your visitors' questions 24/7 - services, pricing, hours, anything on your site.</p><p>You can try it right now:</p><p>${link}</p><p>$14.99 one-time setup. No subscription, no monthly fees. Can be live on your site in one day.</p>${sig}${unsub}`,
    },
    warm: {
      subject: `Love what you're doing at ${p.domain}`,
      body: `<p>${hi}</p><p>I came across ${p.orgName} and thought it was really cool what you're building.</p><p>I make AI assistants for websites like yours - it reads your site and answers visitor questions 24/7. I already made one for you:</p><p>${link}</p><p>$14.99 one-time if you want it on your site. No subscription.</p>${sig}${unsub}`,
    },
    niche_hotel: {
      subject: `Your guests are asking questions at 2am`,
      body: `<p>${hi}</p><p>Travelers browse hotels late at night. They want to know about rooms, availability, check-in times - but nobody's at the front desk to answer.</p><p>I built an AI concierge for ${p.domain} that knows your hotel and answers 24/7:</p><p>${link}</p><p>$14.99 one-time setup. No subscription.</p>${sig}${unsub}`,
    },
    niche_restaurant: {
      subject: `Visitors want to book at ${p.domain} but can't figure out how`,
      body: `<p>${hi}</p><p>I checked ${p.domain} from a customer's perspective. The menu looks great, but when I tried to book a table or ask about dietary options, I couldn't get an instant answer.</p><p>So I built this:</p><p>${link}</p><p>It knows your menu, hours, and can guide visitors to book. $14.99 one-time.</p>${sig}${unsub}`,
    },
    niche_law: {
      subject: `Potential clients leave ${p.domain} without calling`,
      body: `<p>${hi}</p><p>Most people looking for legal help check 3-4 firm websites before picking one. The firm that answers their question first usually wins.</p><p>I built an AI assistant for ${p.domain} that answers practice area questions instantly:</p><p>${link}</p><p>$14.99 one-time setup. Can be live on your site tomorrow.</p>${sig}${unsub}`,
    },
  };

  const t = templates[template] || templates.curiosity;

  // Polish override for PL domains
  if (p.lang === "pl") {
    const plTemplates: Record<string, { subject: string; body: string }> = {
      curiosity: {
        subject: `Szybkie pytanie o ${p.domain}`,
        body: `<p>Czesc ${p.firstName},</p><p>Przegladajac ${p.domain} zainteresowalem sie - czy Twoi odwiedzajacy czasem nie odchodza bez znalezienia tego czego szukaja?</p><p>Zbudowalem cos co moze pomoc. To AI ktore czyta cala Twoja strone i odpowiada na pytania odwiedzajacych 24/7:</p><p>${link}</p><p>$14.99 jednorazowo za instalacje. Bez subskrypcji, bez ukrytych oplat.</p>${sig}${unsub}`,
      },
      problem: {
        subject: `${p.firstName}, odwiedzajacy Twoja strone maja pytania`,
        body: `<p>Czesc ${p.firstName},</p><p>Wiekszosc stron traci odwiedzajacych bo nie moga szybko znalezc odpowiedzi. Telefon nie zawsze dostepny, formularze kontaktowe - odpowiedz po dniach.</p><p>Zbudowalem asystenta AI dla ${p.domain} ktory odpowiada natychmiast - cennik, uslugi, godziny, wszystko co jest na stronie:</p><p>${link}</p><p>$14.99 jednorazowo. Bez subskrypcji.</p>${sig}${unsub}`,
      },
      pricing: {
        subject: `Asystent AI dla ${p.domain} - $14.99 jednorazowo`,
        body: `<p>Czesc ${p.firstName},</p><p>Zbudowalem asystenta AI ktory czyta ${p.domain} i odpowiada na pytania odwiedzajacych 24/7 - uslugi, cennik, godziny, wszystko co jest na stronie.</p><p>Mozesz wyprobowac teraz:</p><p>${link}</p><p>$14.99 jednorazowo za instalacje. Bez subskrypcji. Moze byc na Twojej stronie w jeden dzien.</p>${sig}${unsub}`,
      },
      warm: {
        subject: `Podoba mi sie to co robicie na ${p.domain}`,
        body: `<p>Czesc ${p.firstName},</p><p>Trafilem na ${p.orgName} i spodobalo mi sie to co budujecie.</p><p>Robie asystentow AI dla stron takich jak Twoja - czyta strone i odpowiada na pytania odwiedzajacych 24/7. Juz zrobilem jednego dla Was:</p><p>${link}</p><p>$14.99 jednorazowo jesli chcesz go na swojej stronie. Bez subskrypcji.</p>${sig}${unsub}`,
      },
    };
    const plt = plTemplates[template] || plTemplates.curiosity || t;
    return { subject: plt.subject, html: plt.body };
  }

  return { subject: t.subject, html: t.body };
}

async function sendEmail(p: Prospect & { industry?: string }, demoUrl: string, template: string): Promise<"sent" | "quota" | "fail"> {
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
    console.log(`  [resend] FAIL: ${err.slice(0, 80)}`);
    return "fail";
  } catch { return "fail"; }
}

// --- Main loop ---
async function processOne(): Promise<"sent" | "quota" | "skip" | "done"> {
  // Find next valid prospect
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
    const email = ep.email;
    if (alreadySent(email) || domainSent(domain)) { console.log(`  Skip - already contacted ${domain}`); continue; }
    if (domain.includes("linkedin.com") || domain.includes("facebook.com")) continue;

    const country = ep.country || "Unknown";
    const lang = detectLang(country, domain);
    const tenantId = domain.replace(/[^a-zA-Z0-9]/g, "_");

    console.log(`  Found: ${ep.first_name} <${email}> @ ${domain} [${lang}]`);

    // Register on Render (so demo page works)
    console.log(`  [render] Registering ${domain}...`);
    await registerOnRender(domain);

    // Scrape locally on VPS
    const { success, chunks, pages: scrapePages } = await scrapeLocally(tenantId, domain);
    if (!success) { console.log(`  Skip - scrape failed`); continue; }

    // Send email
    const template = pickTemplate(ep.organization.industry || "");
    const demoUrl = `${BASE_URL}/demo/${tenantId}`;

    if (!SEND) {
      console.log(`  [DRY] [${template}] [${lang}] ${ep.first_name} <${email}> @ ${domain}`);
      state.totalSent++;
      saveState();
      return "sent";
    }

    const result = await sendEmail(
      { firstName: ep.first_name, email, domain, orgName: ep.organization.name, title: ep.title, country, lang, industry: ep.organization.industry || "" },
      demoUrl, template
    );

    if (result === "sent") {
      markSent(email, template);
      state.totalSent++;
      saveState();
      console.log(`  ✉️  [${template}] [${lang}] ${ep.first_name} <${email}> @ ${domain}`);
      // Record to D1 analytics
      recordProspect({
        email, firstName: ep.first_name, domain, orgName: ep.organization.name,
        title: ep.title, country, industry: ep.organization.industry || "unknown",
        lang, template, tenantId, sentAt: new Date().toISOString(),
        scrapePages, scrapeChunks: chunks,
        screenshot: existsSync(resolve(__dirname, `../data/${tenantId}/screenshot.png`)),
      }).catch(() => {});
      return "sent";
    } else if (result === "quota") {
      state.quotaHitAt = new Date().toISOString();
      saveState();
      console.log("  QUOTA HIT");
      return "quota";
    }
    continue;
  }
  return "done";
}

async function main() {
  console.log("=== VPS OUTREACH LOOP (local scraping) ===");
  console.log(`${SEND ? "SENDING" : "DRY RUN"} | Sent: ${state.totalSent} | Enriched: ${state.totalEnriched}`);
  console.log(`Sent log: ${Object.keys(sentLog).length} entries\n`);

  // Clear pending - we don't need it anymore, everything is synchronous
  state.pending = [];
  saveState();

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

    const result = await processOne();
    if (result === "quota") continue;
    if (result === "done") {
      state.keywordOffset++;
      state.apolloPage = 1;
      state.apolloIndex = 0;
      cachedPage = [];
      saveState();
      console.log("Rotating keywords...\n");
    }

    await new Promise(r => setTimeout(r, 2000));
  }
}

main().catch(console.error);
