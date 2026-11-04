import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";
import { LEGAL_PAGES, legalVars, fillLegal } from "../src/legal/pages.js";

// The legal pages ask only for values the server fills, and every value is shown somewhere: an unknown
// placeholder renders as an empty string, an unused one drifts from the code (src/legal/pages.ts).
const env = { COMPANY_NAME: "Whisp sp. z o.o.", COMPANY_ADDRESS: "ul. Przykładowa 1, 00-001 Warszawa", COMPANY_NIP: "1234567890", COMPANY_REGISTRY: "KRS 0000000000", NETWORK_INVITE_PHONE: "+48 729 086 795" };
const html = (file: string) => readFileSync(resolve("public", file), "utf8");
const used = (file: string) => [...html(file).matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]);

describe("legal pages", () => {
  it("fills every placeholder and uses every value", () => {
    const keys = Object.keys(legalVars(env, "PRIVACY_EFFECTIVE_DATE"));
    for (const p of LEGAL_PAGES) {
      expect(used(p.file).filter((k) => !keys.includes(k)), p.file).toEqual([]);
      expect(fillLegal(html(p.file), legalVars(env, p.dateVar)), p.file).not.toContain("{{");
    }
    const all = new Set(LEGAL_PAGES.flatMap((p) => used(p.file)));
    expect(keys.filter((k) => !all.has(k))).toEqual([]);
  });

  it("dates each page by its own setting", () => {
    const e = { ...env, PRIVACY_EFFECTIVE_DATE: "2026-11-20" };
    expect(legalVars(e, "PRIVACY_EFFECTIVE_DATE").EFFECTIVE_DATE).toBe("2026-11-20");
    expect(legalVars(e, "TERMS_EFFECTIVE_DATE").EFFECTIVE_DATE).toBe("2026-10-31");
  });

  it("states the chat retention the deletion job uses", () => {
    const page = fillLegal(html("polityka-prywatnosci.html"), legalVars({ ...env, CHAT_RETENTION_DAYS: "200" }, "PRIVACY_EFFECTIVE_DATE"));
    expect(page).toContain("200 dni");
    expect(page).not.toContain("365");
  });
});
