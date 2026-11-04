import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { __setQuery } from "../src/storage/conversation-store.js";
import { createProject, addParticipant, setMemory, projectDetail, projectsForTenant, seesInPanel } from "../src/projects/store.js";

// The panel shows a business only its own projects and the requests it sent (store.ts seesInPanel).
// Real SQL against in-memory SQLite (D1 is SQLite); the projects are recorded the way network.ts askOne
// records a request to another business.
let db: Database.Database;
beforeAll(() => {
  db = new Database(":memory:");
  __setQuery(async (sql, params = []) => {
    const s = db.prepare(sql);
    if (s.reader) return s.all(...params) as any[];
    s.run(...params);
    return [];
  });
});
afterAll(() => { __setQuery(null); db.close(); });

const HOST = "host_pl", ASKED = "asked_pl", OTHER = "other_pl";

describe("projects in the panel", () => {
  it("a business asked for a part sees its own request, never the customer's project", async () => {
    const parent = await createProject("conversation@1", { customerSession: "s-1", initiatorTenantId: HOST, title: "Wycena tarasu" });
    await setMemory(parent.id, { customerContact: { email: "klient@example.com", phone: "+48600000000", lang: "pl", at: "2026-11-04T10:00:00Z" } });
    const sub = await createProject("business_request@1", { customerSession: `project:${parent.id}`, initiatorTenantId: ASKED, title: "Zapytanie od Host" });
    await addParticipant(sub.id, HOST, "initiator");
    await addParticipant(parent.id, ASKED, "quoting");

    const parentDetail = (await projectDetail(parent.id))!;
    expect(seesInPanel(parentDetail.project, parentDetail.participants, ASKED)).toBe(false);
    expect(seesInPanel(parentDetail.project, parentDetail.participants, HOST)).toBe(true);
    const subDetail = (await projectDetail(sub.id))!;
    expect(seesInPanel(subDetail.project, subDetail.participants, ASKED)).toBe(true);
    expect(seesInPanel(subDetail.project, subDetail.participants, HOST)).toBe(true);
    expect(seesInPanel(subDetail.project, subDetail.participants, OTHER)).toBe(false);

    const asked = await projectsForTenant(ASKED);
    expect(asked.map((p) => p.id)).toEqual([sub.id]);
    expect(JSON.stringify(asked)).not.toContain("klient@example.com");
    expect((await projectsForTenant(HOST)).map((p) => p.id).sort()).toEqual([parent.id, sub.id].sort());
  });

  it("a business keeps its own project when it is also recorded with another role", async () => {
    // tenant-manager.ts: an order sent from the project marks the business "chosen" - on its own project too.
    const p = await createProject("conversation@1", { customerSession: "s-2", initiatorTenantId: OTHER });
    await addParticipant(p.id, OTHER, "chosen");
    const d = (await projectDetail(p.id))!;
    expect(seesInPanel(d.project, d.participants, OTHER)).toBe(true);
    expect((await projectsForTenant(OTHER)).map((x) => x.id)).toEqual([p.id]);
  });
});
