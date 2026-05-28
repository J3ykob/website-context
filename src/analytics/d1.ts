/**
 * Cloudflare D1 analytics - A/B testing, event tracking, reporting.
 * Used by both VPS (outreach loop) and Render (demo visits, chat sessions).
 */

const CF_ACCOUNT_ID = "98e447c9e14d384e1b7e6f4d42c39ad2";
const CF_API_TOKEN = process.env.CF_API_TOKEN || "";
const D1_DATABASE_ID = process.env.D1_DATABASE_ID || "0dec9229-fea2-4343-bf87-d36ac3205979";
const D1_BASE = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/d1/database/${D1_DATABASE_ID}/query`;

async function d1Query(sql: string, params: any[] = []): Promise<any> {
  const resp = await fetch(D1_BASE, {
    method: "POST",
    headers: { Authorization: `Bearer ${CF_API_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  if (!resp.ok) {
    const err = await resp.text();
    console.error(`[d1] Query failed: ${err.slice(0, 100)}`);
    return null;
  }
  const data = await resp.json() as any;
  return data.result?.[0]?.results || [];
}

// --- Write functions (fire-and-forget, never break the pipeline) ---

export async function recordProspect(data: {
  email: string; firstName: string; domain: string; orgName: string;
  title: string; country: string; industry: string; lang: string;
  template: string; tenantId: string; sentAt: string;
  scrapePages: number; scrapeChunks: number; screenshot: boolean;
}): Promise<void> {
  try {
    await d1Query(
      `INSERT OR REPLACE INTO prospects (email, first_name, domain, org_name, title, country, industry, lang, template, tenant_id, sent_at, scrape_pages, scrape_chunks, screenshot)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.email, data.firstName, data.domain, data.orgName, data.title, data.country, data.industry, data.lang, data.template, data.tenantId, data.sentAt, data.scrapePages, data.scrapeChunks, data.screenshot ? 1 : 0]
    );
  } catch (e: any) { console.error(`[d1] recordProspect failed: ${e.message}`); }
}

export async function recordEvent(prospectEmail: string, eventType: string, metadata?: object): Promise<void> {
  try {
    await d1Query(
      `INSERT INTO events (prospect_email, event_type, metadata_json) VALUES (?, ?, ?)`,
      [prospectEmail, eventType, JSON.stringify(metadata || {})]
    );
  } catch (e: any) { console.error(`[d1] recordEvent failed: ${e.message}`); }
}

export async function recordEmailEvent(prospectEmail: string, resendEvent: string, resendId?: string): Promise<void> {
  try {
    await d1Query(
      `INSERT INTO email_events (prospect_email, resend_event, resend_id) VALUES (?, ?, ?)`,
      [prospectEmail, resendEvent, resendId || ""]
    );
  } catch (e: any) { console.error(`[d1] recordEmailEvent failed: ${e.message}`); }
}

// --- Read functions (reporting) ---

export async function getTemplateStats(): Promise<any[]> {
  return d1Query(`
    SELECT p.template,
      COUNT(DISTINCT p.email) as sent,
      COUNT(DISTINCT CASE WHEN e.event_type = 'demo_visit' THEN p.email END) as visits,
      COUNT(DISTINCT CASE WHEN e.event_type = 'chat_start' THEN p.email END) as chats,
      COUNT(DISTINCT CASE WHEN e.event_type = 'unsubscribe' THEN p.email END) as unsubs
    FROM prospects p
    LEFT JOIN events e ON p.email = e.prospect_email
    GROUP BY p.template
  `);
}

export async function getCountryBreakdown(): Promise<any[]> {
  return d1Query(`
    SELECT p.country, COUNT(*) as sent,
      COUNT(DISTINCT CASE WHEN e.event_type = 'demo_visit' THEN p.email END) as visits,
      COUNT(DISTINCT CASE WHEN e.event_type = 'chat_start' THEN p.email END) as chats
    FROM prospects p LEFT JOIN events e ON p.email = e.prospect_email
    GROUP BY p.country ORDER BY sent DESC LIMIT 20
  `);
}

export async function getIndustryBreakdown(): Promise<any[]> {
  return d1Query(`
    SELECT p.industry, COUNT(*) as sent,
      COUNT(DISTINCT CASE WHEN e.event_type = 'demo_visit' THEN p.email END) as visits,
      COUNT(DISTINCT CASE WHEN e.event_type = 'chat_start' THEN p.email END) as chats
    FROM prospects p LEFT JOIN events e ON p.email = e.prospect_email
    GROUP BY p.industry ORDER BY sent DESC LIMIT 20
  `);
}

export async function getFunnel(): Promise<any> {
  const rows = await d1Query(`
    SELECT
      COUNT(DISTINCT p.email) as total_sent,
      COUNT(DISTINCT CASE WHEN ee.resend_event = 'delivered' THEN p.email END) as delivered,
      COUNT(DISTINCT CASE WHEN ee.resend_event = 'opened' THEN p.email END) as opened,
      COUNT(DISTINCT CASE WHEN ev.event_type = 'demo_visit' THEN p.email END) as visited,
      COUNT(DISTINCT CASE WHEN ev.event_type = 'chat_start' THEN p.email END) as chatted,
      COUNT(DISTINCT CASE WHEN ev.event_type = 'unsubscribe' THEN p.email END) as unsubbed
    FROM prospects p
    LEFT JOIN email_events ee ON p.email = ee.prospect_email
    LEFT JOIN events ev ON p.email = ev.prospect_email
  `);
  return rows?.[0] || {};
}

export async function getProspectJourney(email: string): Promise<any> {
  const prospect = await d1Query(`SELECT * FROM prospects WHERE email = ?`, [email]);
  const events = await d1Query(`SELECT * FROM events WHERE prospect_email = ? ORDER BY created_at`, [email]);
  const emailEvents = await d1Query(`SELECT * FROM email_events WHERE prospect_email = ? ORDER BY created_at`, [email]);
  return { prospect: prospect?.[0], events, emailEvents };
}

export async function getDailyStats(days: number = 7): Promise<any[]> {
  return d1Query(`
    SELECT DATE(sent_at) as day, COUNT(*) as sent, template,
      COUNT(DISTINCT CASE WHEN e.event_type = 'demo_visit' THEN p.email END) as visits
    FROM prospects p LEFT JOIN events e ON p.email = e.prospect_email
    WHERE sent_at > datetime('now', '-' || ? || ' days')
    GROUP BY day, template ORDER BY day DESC
  `, [days]);
}

// --- Tenant ID to email lookup (for Render to log events) ---

let tenantEmailCache: Map<string, string> = new Map();
let cacheAge = 0;

export async function getEmailForTenant(tenantId: string): Promise<string | null> {
  if (Date.now() - cacheAge > 300000) {
    const rows = await d1Query(`SELECT tenant_id, email FROM prospects`);
    tenantEmailCache = new Map((rows || []).map((r: any) => [r.tenant_id, r.email]));
    cacheAge = Date.now();
  }
  return tenantEmailCache.get(tenantId) || null;
}
