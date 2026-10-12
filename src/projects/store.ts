/**
 * Projects: the container for every interaction that involves more than one
 * business (a referral, an offer comparison, an order split across shops...).
 * A project has a type with a version (so types can change over time without
 * breaking running projects), a status, its participants and their roles, a
 * structured memory, an append-only event log, the customer's consents (which
 * of their details went to which business), and usage (LLM / Jev calls, cost).
 * It maps directly onto an A2A task (id, status, history, artifacts), which is
 * what makes later integration a translation, not a rebuild.
 *
 * Stored in D1 (projects, project_events, project_participants, project_consents).
 */
import { randomBytes } from "crypto";
import { d1Query } from "../storage/conversation-store.js";

export type ProjectStatus = "open" | "waiting_customer" | "waiting_business" | "done" | "cancelled" | "expired";
export type ParticipantRole = "customer" | "initiator" | "quoting" | "recommended" | "chosen" | "declined";

export interface Project {
  id: string;
  type: string;            // e.g. "referral@1", "compare_offers@1"
  status: ProjectStatus;
  customerSession: string; // the visitor session that owns it
  initiatorTenantId: string;
  title: string;
  memory: Record<string, unknown>;
  usage: { llmCalls: number; jevCalls: number; costUsd: number };
  createdAt: string;
  updatedAt: string;
  expiresAt: string | null;
}
export interface ProjectEvent { at: string; kind: string; actor: string; data: Record<string, unknown> }
export interface Participant { tenantId: string; role: ParticipantRole; joinedAt: string }
export interface Consent { at: string; toTenantId: string; fields: string[]; text: string }

let ready: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  ready ||= (async () => {
    await d1Query("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL, customer_session TEXT NOT NULL, initiator_tenant TEXT NOT NULL, title TEXT, memory TEXT NOT NULL DEFAULT '{}', llm_calls INTEGER DEFAULT 0, jev_calls INTEGER DEFAULT 0, cost_usd REAL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, expires_at TEXT)");
    await d1Query("CREATE INDEX IF NOT EXISTS projects_session ON projects (customer_session)");
    await d1Query("CREATE TABLE IF NOT EXISTS project_events (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL, actor TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}')");
    await d1Query("CREATE INDEX IF NOT EXISTS project_events_project ON project_events (project_id)");
    await d1Query("CREATE TABLE IF NOT EXISTS project_participants (project_id TEXT NOT NULL, tenant_id TEXT NOT NULL, role TEXT NOT NULL, joined_at TEXT NOT NULL, PRIMARY KEY (project_id, tenant_id))");
    await d1Query("CREATE INDEX IF NOT EXISTS project_participants_tenant ON project_participants (tenant_id)");
    await d1Query("CREATE TABLE IF NOT EXISTS project_consents (id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, at TEXT NOT NULL, to_tenant TEXT NOT NULL, fields TEXT NOT NULL, consent_text TEXT NOT NULL)");
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

const now = () => new Date().toISOString();
const json = (v: unknown) => JSON.stringify(v ?? {});
const parse = (t: unknown) => { try { return JSON.parse(String(t || "{}")); } catch { return {}; } };

function row(r: any): Project {
  return {
    id: r.id, type: r.type, status: r.status, customerSession: r.customer_session, initiatorTenantId: r.initiator_tenant,
    title: r.title || "", memory: parse(r.memory),
    usage: { llmCalls: Number(r.llm_calls) || 0, jevCalls: Number(r.jev_calls) || 0, costUsd: Number(r.cost_usd) || 0 },
    createdAt: r.created_at, updatedAt: r.updated_at, expiresAt: r.expires_at || null,
  };
}

/** A new project. The initiator joins as "initiator"; the event log starts with "created". */
export async function createProject(type: string, opts: { customerSession: string; initiatorTenantId: string; title?: string; memory?: Record<string, unknown>; ttlHours?: number }): Promise<Project> {
  await ensureSchema();
  const id = `prj_${randomBytes(12).toString("base64url")}`;
  const t = now();
  const expires = opts.ttlHours ? new Date(Date.now() + opts.ttlHours * 3600 * 1000).toISOString() : null;
  await d1Query("INSERT INTO projects (id, type, status, customer_session, initiator_tenant, title, memory, created_at, updated_at, expires_at) VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)",
    [id, type.slice(0, 60), opts.customerSession.slice(0, 200), opts.initiatorTenantId.slice(0, 120), (opts.title || "").slice(0, 200), json(opts.memory), t, t, expires]);
  await addParticipant(id, opts.initiatorTenantId, "initiator");
  await addEvent(id, { kind: "created", actor: opts.initiatorTenantId, data: { type } });
  return (await getProject(id))!;
}

export async function getProject(id: string): Promise<Project | null> {
  await ensureSchema();
  const r = (await d1Query("SELECT * FROM projects WHERE id = ?", [id]))[0];
  return r ? row(r) : null;
}

/** The customer's open project of a type, if any (to continue rather than start another). */
export async function findOpenProject(customerSession: string, type: string): Promise<Project | null> {
  await ensureSchema();
  const r = (await d1Query("SELECT * FROM projects WHERE customer_session = ? AND type = ? AND status NOT IN ('done','cancelled','expired') ORDER BY created_at DESC LIMIT 1", [customerSession, type]))[0];
  return r ? row(r) : null;
}

export async function addEvent(id: string, e: { kind: string; actor: string; data?: Record<string, unknown> }): Promise<void> {
  await ensureSchema();
  const t = now();
  await d1Query("INSERT INTO project_events (project_id, at, kind, actor, data) VALUES (?, ?, ?, ?, ?)", [id, t, e.kind.slice(0, 60), e.actor.slice(0, 120), json(e.data).slice(0, 20000)]);
  await d1Query("UPDATE projects SET updated_at = ? WHERE id = ?", [t, id]);
}

/** Shallow-merges keys into the project's memory. */
export async function setMemory(id: string, patch: Record<string, unknown>): Promise<void> {
  const p = await getProject(id);
  if (!p) throw new Error(`no project ${id}`);
  await d1Query("UPDATE projects SET memory = ?, updated_at = ? WHERE id = ?", [json({ ...p.memory, ...patch }).slice(0, 200000), now(), id]);
}

export async function setStatus(id: string, status: ProjectStatus, actor: string): Promise<void> {
  await ensureSchema();
  await d1Query("UPDATE projects SET status = ?, updated_at = ? WHERE id = ?", [status, now(), id]);
  await addEvent(id, { kind: "status", actor, data: { status } });
}

export async function addParticipant(id: string, tenantId: string, role: ParticipantRole): Promise<void> {
  await ensureSchema();
  await d1Query("INSERT INTO project_participants (project_id, tenant_id, role, joined_at) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, tenant_id) DO UPDATE SET role = excluded.role", [id, tenantId, role, now()]);
}

/** What the customer agreed to share with which business - before it is shared. */
export async function recordConsent(id: string, c: { toTenantId: string; fields: string[]; text: string }): Promise<void> {
  await ensureSchema();
  await d1Query("INSERT INTO project_consents (project_id, at, to_tenant, fields, consent_text) VALUES (?, ?, ?, ?, ?)", [id, now(), c.toTenantId, json(c.fields), c.text.slice(0, 2000)]);
  await addEvent(id, { kind: "consent", actor: "customer", data: { toTenantId: c.toTenantId, fields: c.fields } });
}

export async function addUsage(id: string, u: { llmCalls?: number; jevCalls?: number; costUsd?: number }): Promise<void> {
  await ensureSchema();
  await d1Query("UPDATE projects SET llm_calls = llm_calls + ?, jev_calls = jev_calls + ?, cost_usd = cost_usd + ? WHERE id = ?", [u.llmCalls || 0, u.jevCalls || 0, u.costUsd || 0, id]);
}

/** Everything about one project, for the dashboard / an integration. */
export async function listParticipants(id: string): Promise<Participant[]> {
  await ensureSchema();
  return (await d1Query("SELECT tenant_id, role, joined_at FROM project_participants WHERE project_id = ?", [id]))
    .map((r: any) => ({ tenantId: r.tenant_id, role: r.role, joinedAt: r.joined_at }));
}

export async function projectDetail(id: string): Promise<{ project: Project; participants: Participant[]; events: ProjectEvent[]; consents: Consent[] } | null> {
  const project = await getProject(id);
  if (!project) return null;
  const [parts, events, consents] = await Promise.all([
    d1Query("SELECT tenant_id, role, joined_at FROM project_participants WHERE project_id = ?", [id]),
    d1Query("SELECT at, kind, actor, data FROM project_events WHERE project_id = ? ORDER BY id LIMIT 500", [id]),
    d1Query("SELECT at, to_tenant, fields, consent_text FROM project_consents WHERE project_id = ? ORDER BY id", [id]),
  ]);
  return {
    project,
    participants: parts.map((r: any) => ({ tenantId: r.tenant_id, role: r.role, joinedAt: r.joined_at })),
    events: events.map((r: any) => ({ at: r.at, kind: r.kind, actor: r.actor, data: parse(r.data) })),
    consents: consents.map((r: any) => ({ at: r.at, toTenantId: r.to_tenant, fields: (() => { try { return JSON.parse(r.fields); } catch { return []; } })(), text: r.consent_text })),
  };
}

/** A business's projects (newest first), for its dashboard. */
export async function projectsForTenant(tenantId: string, limit = 50): Promise<(Project & { role: ParticipantRole })[]> {
  await ensureSchema();
  const rows = await d1Query("SELECT p.*, pp.role AS role FROM projects p JOIN project_participants pp ON pp.project_id = p.id WHERE pp.tenant_id = ? ORDER BY p.updated_at DESC LIMIT ?", [tenantId, limit]);
  return rows.map((r: any) => ({ ...row(r), role: r.role }));
}
