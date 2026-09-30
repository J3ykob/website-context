import { describe, it, expect } from "vitest";
import { rankMatches, planOf, type RankInput } from "../src/ecosystem/rank.js";

const m = (id: string, offers: number, vector: number, plan: RankInput["plan"] = "free") => ({ id, offers, vector, plan });

describe("ecosystem ranking", () => {
  it("keeps only the top k of the qualified businesses", () => {
    const items = Array.from({ length: 100 }, (_, i) => m(`b${i}`, 0.5 + (i % 50) / 100, 0.4));
    expect(rankMatches(items, 3)).toHaveLength(3);
  });

  it("never ranks a business whose content doesn't show the offer, whatever its plan", () => {
    const r = rankMatches([m("paid-irrelevant", 0.2, 0.9, "premium"), m("free-relevant", 0.8, 0.4)], 3);
    expect(r.map((x) => x.id)).toEqual(["free-relevant"]);
  });

  it("a paid plan moves a qualified business ahead of a comparable free one", () => {
    const r = rankMatches([m("free", 0.9, 0.5), m("pro", 0.85, 0.5, "pro"), m("free2", 0.88, 0.5)], 2);
    expect(r.map((x) => x.id)).toEqual(["pro", "free"]);
  });

  it("a paid plan does not beat a much stronger free offer", () => {
    const r = rankMatches([m("free-strong", 0.98, 0.5), m("pro-weak", 0.55, 0.5, "pro")], 1);
    expect(r[0].id).toBe("free-strong");
  });

  it("breaks ties by vector similarity", () => {
    const r = rankMatches([m("a", 0.9, 0.4), m("b", 0.9, 0.6)], 1);
    expect(r[0].id).toBe("b");
  });
});

describe("planOf", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  it("defaults to free", () => {
    expect(planOf(undefined, now)).toBe("free");
    expect(planOf({ ecosystemPlan: { tier: "gold" } }, now)).toBe("free");
  });
  it("honours a plan until it expires", () => {
    expect(planOf({ ecosystemPlan: { tier: "pro", until: "2026-12-31" } }, now)).toBe("pro");
    expect(planOf({ ecosystemPlan: { tier: "premium", until: "2026-09-01" } }, now)).toBe("free");
    expect(planOf({ ecosystemPlan: { tier: "premium" } }, now)).toBe("premium");
  });
});
