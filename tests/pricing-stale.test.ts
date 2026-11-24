import { describe, it, expect, vi } from "vitest";

// R2 as a map: the stored quoting model and the offer pages the last scrape kept.
const files = new Map<string, string>();
vi.mock("../src/storage/r2.js", () => ({
  downloadFromR2: async (key: string) => (files.has(key) ? Buffer.from(files.get(key)!) : null),
  uploadToR2: async (key: string, body: string) => { files.set(key, body); return true; },
}));

describe("a quoting model is used only while it matches the scraped pages", () => {
  it("built from the kept pages: used; pages changed since: not used", async () => {
    const m = await import("../src/pricing/model.js");
    const pages = [{ url: "https://x.example/cennik", text: "Pakiet Komfort 2500 zł" }];
    const pb = { tenantId: "t1", hash: m.pagesHash("claude-code:opus", pages), builtAt: "2026-10-31T18:30:39.237Z", model: "claude-code:opus", parts: [{ catalog: { business: "x", currency: "PLN", shared: [], items: [] }, code: "", source: "", model: "" }], costUsd: 0, missing: [] };
    await m.savePricing(pb as any);
    files.set("tenants/t1/offer-pages.json", JSON.stringify(pages));
    expect((await m.loadCurrentPricing("t1"))?.hash).toBe(pb.hash);
    // The site was read again and the price changed.
    files.set("tenants/t1/offer-pages.json", JSON.stringify([{ url: pages[0].url, text: "Pakiet Komfort 3000 zł" }]));
    expect(await m.loadCurrentPricing("t1")).toBeNull();
    // The pages are gone: nothing to check it against.
    files.delete("tenants/t1/offer-pages.json");
    expect(await m.loadCurrentPricing("t1")).toBeNull();
    // No model at all stays "no model".
    expect(await m.loadCurrentPricing("t2")).toBeNull();
  });
});
