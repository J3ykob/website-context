import { describe, it, expect } from "vitest";
import { ownedSites, maySwitch } from "../src/multi-tenant/sites.js";

const site = (id: string, over: Record<string, unknown> = {}): any => ({
  id, email: "owner@firma.pl", domain: `${id}.pl`, siteUrl: `https://${id}.pl`, brandName: null, status: "active",
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", lastScrapedAt: null, pagesCount: 1, chunksCount: 1,
  qdrantCollection: "", ownerPasswordHash: "hash", settings: { confirmedEmail: "owner@firma.pl" }, ...over,
});

describe("the sites one owner may switch between", () => {
  it("lists the owner's other confirmed sites, the current one first, then newest first", () => {
    const a = site("a"), b = site("b", { createdAt: "2026-11-05T00:00:00Z" }), c = site("c", { createdAt: "2026-11-10T00:00:00Z" });
    expect(ownedSites(a, [b, a, c]).map((t) => t.id)).toEqual(["a", "c", "b"]);
    expect(maySwitch(a, "b", [a, b, c])).toBe(true);
  });

  it("the address matches in any case and with spaces", () => {
    const a = site("a"), b = site("b", { email: " Owner@Firma.pl ", settings: { confirmedEmail: "owner@firma.pl" } });
    expect(maySwitch(a, "b", [a, b])).toBe(true);
  });

  it("a site registered to the address that nobody has claimed yet (no password) is included", () => {
    const a = site("a"), fresh = site("fresh", { ownerPasswordHash: null, settings: { setupEmail: "owner@firma.pl" } });
    expect(maySwitch(a, "fresh", [a, fresh])).toBe(true);
    expect(maySwitch(a, "old", [a, site("old", { ownerPasswordHash: null, settings: {} })])).toBe(true);
    // Registered to another address: never.
    expect(maySwitch(a, "theirs", [a, site("theirs", { ownerPasswordHash: null, email: "other@firma.pl", settings: {} })])).toBe(false);
  });

  it("never another owner's site", () => {
    const a = site("a");
    expect(maySwitch(a, "x", [a, site("x", { email: "other@firma.pl", settings: { confirmedEmail: "other@firma.pl" } })])).toBe(false);
    expect(maySwitch(a, "missing", [a])).toBe(false);
  });

  it("a site with a password whose address nobody confirmed, or set with the apiKey, is not listed", () => {
    const a = site("a");
    expect(maySwitch(a, "u", [a, site("u", { settings: {} })])).toBe(false);
    expect(maySwitch(a, "k", [a, site("k", { settings: { confirmedEmail: "owner@firma.pl", claimedWithApiKey: true } })])).toBe(false);
  });

  it("a session that has not proven the mailbox switches nowhere (a stranger who typed the owner's address)", () => {
    const victim = site("victim"), fresh = site("fresh", { ownerPasswordHash: null, settings: { setupEmail: "owner@firma.pl" } });
    const typed = site("typed", { settings: { confirmedEmail: "owner@firma.pl", claimedWithApiKey: true } });
    expect(ownedSites(typed, [typed, victim, fresh])).toEqual([]);
    expect(ownedSites(site("unconfirmed", { settings: {} }), [victim])).toEqual([]);
    expect(ownedSites(site("nopass", { ownerPasswordHash: null }), [victim])).toEqual([]);
  });
});

describe("a switched session remembers the account it came from", () => {
  it("reads the origin out of a switched token, with or without the admin mark, and nothing out of a login's token", async () => {
    const { sessionOrigin } = await import("../src/multi-tenant/d1-auth.js");
    const via = `via.${Buffer.from("www_firma_pl").toString("base64url")}.${"a".repeat(64)}`;
    expect(sessionOrigin(via)).toBe("www_firma_pl");
    expect(sessionOrigin(`adm-${via}`)).toBe("www_firma_pl");
    expect(sessionOrigin("a".repeat(64))).toBeNull();
    expect(sessionOrigin(`adm-${"a".repeat(64)}`)).toBeNull();
  });
});
