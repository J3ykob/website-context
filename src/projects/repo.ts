/**
 * A project's repository: its working files, requirements and their
 * verification.
 *
 *   Files       - R2 projects/<id>/<path> (CSV, cost estimates, notes, reports),
 *                 indexed in D1 (project_files). Written by code and by agents.
 *   Requirements- what the result must satisfy (from the customer, the system or
 *                 a business), each with a check, a status and its evidence
 *                 (project_requirements).
 *   Checks      - code checks (exact: sums, every line priced or explained...)
 *                 and Jev checks (judgments: "the reply does not call a priced
 *                 item 'to be priced'"); every run is recorded in the report
 *                 file and the event log.
 *
 * Calculations are done by code (calc helpers below), never by a model.
 */
import { d1Query } from "../storage/conversation-store.js";
import { addEvent } from "./store.js";

export type FileKind = "csv" | "json" | "md" | "txt" | "bin";
export interface RepoFile { path: string; kind: FileKind; size: number; author: string; createdAt: string }
export type ReqStatus = "open" | "met" | "failed" | "not_applicable";
export interface Requirement { id: string; text: string; source: "customer" | "system" | "business"; check: string; status: ReqStatus; evidence: string; verifiedAt: string | null }

let ready: Promise<void> | null = null;
function ensureSchema(): Promise<void> {
  ready ||= (async () => {
    await d1Query("CREATE TABLE IF NOT EXISTS project_files (project_id TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL, size INTEGER NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (project_id, path))");
    await d1Query("CREATE TABLE IF NOT EXISTS project_requirements (project_id TEXT NOT NULL, id TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, check_kind TEXT NOT NULL, status TEXT NOT NULL, evidence TEXT NOT NULL DEFAULT '', verified_at TEXT, PRIMARY KEY (project_id, id))");
  })().catch((e) => { ready = null; throw e; });
  return ready;
}

const key = (id: string, path: string) => `projects/${id}/${path}`;
function safePath(path: string): string {
  const p = path.split("/").filter((s) => s && s !== "." && s !== "..").join("/").slice(0, 200);
  if (!p) throw new Error("bad path");
  return p;
}

/** Writes (or replaces) a file in the project repository. */
export async function writeFile(id: string, path: string, content: string, kind: FileKind, author: string): Promise<void> {
  await ensureSchema();
  const p = safePath(path);
  const { uploadToR2 } = await import("../storage/r2.js");
  const type = kind === "csv" ? "text/csv; charset=utf-8" : kind === "json" ? "application/json" : kind === "md" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
  if (!(await uploadToR2(key(id, p), content, type))) throw new Error(`could not store ${p}`);
  await d1Query("INSERT INTO project_files (project_id, path, kind, size, author, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(project_id, path) DO UPDATE SET kind = excluded.kind, size = excluded.size, author = excluded.author, created_at = excluded.created_at",
    [id, p, kind, Buffer.byteLength(content), author.slice(0, 120), new Date().toISOString()]);
}

/** Writes (or replaces) a binary file (e.g. a spreadsheet an agent made). */
export async function writeBinaryFile(id: string, path: string, content: Buffer, author: string): Promise<void> {
  await ensureSchema();
  const p = safePath(path);
  const { uploadToR2 } = await import("../storage/r2.js");
  if (!(await uploadToR2(key(id, p), content, "application/octet-stream"))) throw new Error(`could not store ${p}`);
  await d1Query("INSERT INTO project_files (project_id, path, kind, size, author, created_at) VALUES (?, ?, 'bin', ?, ?, ?) ON CONFLICT(project_id, path) DO UPDATE SET kind = excluded.kind, size = excluded.size, author = excluded.author, created_at = excluded.created_at",
    [id, p, content.byteLength, author.slice(0, 120), new Date().toISOString()]);
}

/** Removes a file from the project repository (no error when it is not there). */
export async function deleteFile(id: string, path: string): Promise<void> {
  await ensureSchema();
  const p = safePath(path);
  const { deleteFromR2 } = await import("../storage/r2.js");
  await deleteFromR2(key(id, p)).catch(() => {});
  await d1Query("DELETE FROM project_files WHERE project_id = ? AND path = ?", [id, p]);
}

export async function readFile(id: string, path: string): Promise<string | null> {
  const { downloadFromR2 } = await import("../storage/r2.js");
  const buf = await downloadFromR2(key(id, safePath(path)));
  return buf ? buf.toString("utf-8") : null;
}

export async function readFileBuffer(id: string, path: string): Promise<Buffer | null> {
  const { downloadFromR2 } = await import("../storage/r2.js");
  return downloadFromR2(key(id, safePath(path)));
}

export async function listFiles(id: string): Promise<RepoFile[]> {
  await ensureSchema();
  return (await d1Query("SELECT path, kind, size, author, created_at FROM project_files WHERE project_id = ? ORDER BY path", [id]))
    .map((r: any) => ({ path: r.path, kind: r.kind, size: Number(r.size), author: r.author, createdAt: r.created_at }));
}

// ── Requirements ──
export async function addRequirement(id: string, r: { id: string; text: string; source: Requirement["source"]; check: string }): Promise<void> {
  await ensureSchema();
  await d1Query("INSERT INTO project_requirements (project_id, id, text, source, check_kind, status) VALUES (?, ?, ?, ?, ?, 'open') ON CONFLICT(project_id, id) DO UPDATE SET text = excluded.text, check_kind = excluded.check_kind",
    [id, r.id.slice(0, 60), r.text.slice(0, 500), r.source, r.check.slice(0, 60)]);
}

export async function setRequirement(id: string, reqId: string, status: ReqStatus, evidence: string): Promise<void> {
  await ensureSchema();
  await d1Query("UPDATE project_requirements SET status = ?, evidence = ?, verified_at = ? WHERE project_id = ? AND id = ?", [status, evidence.slice(0, 1000), new Date().toISOString(), id, reqId]);
}

export async function listRequirements(id: string): Promise<Requirement[]> {
  await ensureSchema();
  return (await d1Query("SELECT * FROM project_requirements WHERE project_id = ? ORDER BY id", [id])).map((r: any) => ({
    id: r.id, text: r.text, source: r.source, check: r.check_kind, status: r.status, evidence: r.evidence || "", verifiedAt: r.verified_at || null,
  }));
}

/** Records the outcome of a set of checks: requirement statuses, a report file, an event. */
export async function recordVerification(id: string, results: { reqId: string; status: ReqStatus; evidence: string }[], author = "system", file = "verification.json"): Promise<{ met: number; failed: number }> {
  for (const r of results) await setRequirement(id, r.reqId, r.status, r.evidence);
  const met = results.filter((r) => r.status === "met").length, failed = results.filter((r) => r.status === "failed").length;
  await writeFile(id, file, JSON.stringify({ at: new Date().toISOString(), met, failed, results }, null, 2), "json", author);
  // Which checks failed, with their wording: a failed check sends the result to the owner or into
  // another run, and intermittent ones (a planner criterion) are otherwise invisible once data is gone.
  const failedReqs = failed ? (await listRequirements(id)).filter((r) => results.some((x) => x.reqId === r.id && x.status === "failed")) : [];
  if (failedReqs.length) console.warn(`[verification] ${id}: ${failed} failed - ${failedReqs.map((r) => `${r.id} "${r.text.slice(0, 140)}" (${r.evidence.slice(0, 120)})`).join(" | ")}`);
  await addEvent(id, { kind: "verification", actor: author, data: { met, failed, file, ...(failedReqs.length ? { failedReqs: failedReqs.map((r) => ({ id: r.id, text: r.text.slice(0, 200), evidence: r.evidence.slice(0, 200) })) } : {}) } });
  return { met, failed };
}

// ── Calculations (code, exact to the grosz) ──
export const calc = {
  round: (n: number) => Math.round(n * 100) / 100,
  mul: (a: number, b: number) => Math.round(a * b * 100) / 100,
  sum: (xs: number[]) => Math.round(xs.reduce((s, x) => s + Math.round(x * 100), 0)) / 100,
};

/** A CSV from rows (RFC 4180 quoting, ";" separator so Polish Excel opens it). */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const t = v === null || v === undefined ? "" : typeof v === "number" ? String(v).split(".").join(",") : v;
    let needs = false;
    for (const ch of t) if (ch === ";" || ch === '"' || ch === "\n" || ch === "\r") { needs = true; break; }
    return needs ? `"${t.split('"').join('""')}"` : t;
  };
  return "﻿" + [header, ...rows].map((r) => r.map(cell).join(";")).join("\r\n");
}
