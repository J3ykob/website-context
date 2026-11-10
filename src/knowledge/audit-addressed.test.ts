/**
 * "Worth adding" hints the owner has acted on (tenants/<id>/audit-addressed.json), the knowledge-audit view the
 * panel reads, and the audit's structured fields the panel relies on instead of the detail text.
 */
import { describe, it, expect, vi } from "vitest";
import { isHintKey, parseAddressed, markAddressed, addressedSince, auditView } from "./audit-addressed.js";
import { AUDIT_HINT_KEYS, SELF_TEST_QUESTIONS } from "./audit-questions.js";

vi.mock("../llm/jev.js", () => ({ jevAsk: vi.fn(async () => ({ gives: { noul: 0.9 }, some: { noul: 0.9 } })) }));

describe("hint keys", () => {
  it("are the data topics and the question topics, and nothing else", () => {
    expect(AUDIT_HINT_KEYS).toEqual([
      "data.pages", "data.garbled", "data.phone", "data.email", "data.address", "data.hours",
      "question.contact", "question.hours", "question.area", "question.prices", "question.quote",
      "question.payment", "question.warranty", "question.lead_time",
    ]);
    expect(SELF_TEST_QUESTIONS.length).toBe(16);
    expect(isHintKey("data.phone")).toBe(true);
    expect(isHintKey("data.fax")).toBe(false);
    expect(isHintKey("__proto__")).toBe(false);
    expect(isHintKey(42)).toBe(false);
  });
});

describe("parseAddressed", () => {
  it("keeps known keys with valid times and drops the rest", () => {
    const raw = JSON.stringify({ "data.phone": "2026-11-10T10:00:00Z", "data.fax": "2026-11-10T10:00:00Z", "question.prices": "not a date", "question.area": 5 });
    expect(parseAddressed(raw)).toEqual({ "data.phone": "2026-11-10T10:00:00Z" });
  });
  it("treats a missing or broken file as nothing handled", () => {
    expect(parseAddressed(null)).toEqual({});
    expect(parseAddressed("")).toEqual({});
    expect(parseAddressed("{oops")).toEqual({});
    expect(parseAddressed("[1,2]")).toEqual({});
    expect(parseAddressed("null")).toEqual({});
  });
});

describe("markAddressed", () => {
  it("adds or refreshes a key without touching the others", () => {
    const a = markAddressed({}, "data.phone", "2026-11-10T10:00:00Z");
    const b = markAddressed(a, "question.prices", "2026-11-10T11:00:00Z");
    const c = markAddressed(b, "data.phone", "2026-11-10T12:00:00Z");
    expect(a).toEqual({ "data.phone": "2026-11-10T10:00:00Z" });
    expect(c).toEqual({ "data.phone": "2026-11-10T12:00:00Z", "question.prices": "2026-11-10T11:00:00Z" });
  });
  it("refuses a key that is not ours", () => {
    expect(() => markAddressed({}, "data.fax", "2026-11-10T10:00:00Z")).toThrow();
  });
});

describe("addressedSince", () => {
  const addressed = { "data.phone": "2026-11-10T10:00:00Z", "question.prices": "2026-11-01T10:00:00Z" };
  it("counts only what was handled after the report", () => {
    expect(addressedSince(addressed, "2026-11-05T00:00:00Z")).toEqual(["data.phone"]);
    expect(addressedSince(addressed, "2026-10-01T00:00:00Z")).toEqual(["data.phone", "question.prices"]);
  });
  it("a newer report brings every hint back", () => {
    expect(addressedSince(addressed, "2026-11-11T00:00:00Z")).toEqual([]);
  });
  it("no report time: none", () => {
    expect(addressedSince(addressed, undefined)).toEqual([]);
    expect(addressedSince(addressed, "garbage")).toEqual([]);
  });
});

describe("auditView (GET /api/dashboard/knowledge-audit)", () => {
  const report = { tenantId: "t", at: "2026-11-05T00:00:00Z", language: "pl", items: [{ kind: "data", topic: "phone", status: "missing", detail: "" }], summary: { ok: 0, partial: 0, missing: 1 } };
  it("returns the report with the keys handled since", () => {
    const v = auditView(JSON.stringify(report), JSON.stringify({ "data.phone": "2026-11-10T10:00:00Z" }));
    expect(v.items).toEqual(report.items);
    expect(v.at).toBe(report.at);
    expect(v.addressed).toEqual(["data.phone"]);
  });
  it("no file, or an unreadable one: no items", () => {
    expect(auditView(null, null)).toEqual({ items: [], addressed: [] });
    expect(auditView("{broken", null)).toEqual({ items: [], addressed: [] });
    expect(auditView(JSON.stringify({ at: "x" }), null)).toEqual({ items: [], addressed: [] });
  });
  it("no addressed file: nothing handled", () => {
    expect(auditView(JSON.stringify(report), null).addressed).toEqual([]);
  });
});

describe("audit structured fields", () => {
  it("a test question that failed to run is marked failed, a run one is not", async () => {
    const { questionChecks } = await import("./audit.js");
    let calls = 0;
    const probe = async (q: string) => {
      calls++;
      if (q === SELF_TEST_QUESTIONS[0]) throw new Error("llm down"); // the contact question (pl)
      return { reply: "Tak, cennik jest na stronie: 100 zł za godzinę.", behaviour: [], route: "answer" };
    };
    const items = await questionChecks(probe, "pl");
    const contact = items.find((i) => i.topic === "contact")!;
    expect(contact.failed).toBe(true);
    expect(items.filter((i) => i.topic !== "contact").every((i) => !i.failed && i.status === "ok")).toBe(true);
    expect(calls).toBe(8 + 1); // the failed one was tried twice
  });
  it("the pages item lists the pages that gave no text", async () => {
    const { dataChecks } = await import("./audit.js");
    const context: any = {
      siteMap: [{ url: "https://ex.pl/" }, { url: "https://ex.pl/oferta" }, { url: "https://ex.pl/galeria" }],
      pages: [], businessProfile: { primaryPhone: "+48 1", primaryEmail: "a@ex.pl", primaryAddress: "x", openingHours: "8-16" },
    };
    const catalog: any = { chunks: [{ url: "https://ex.pl/", content: "tekst" }] };
    const pages = dataChecks(context, catalog).find((i) => i.topic === "pages")!;
    expect(pages.urls).toEqual(["https://ex.pl/oferta", "https://ex.pl/galeria"]);
  });
});
