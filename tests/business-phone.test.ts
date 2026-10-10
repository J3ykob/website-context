import { describe, it, expect } from "vitest";
import { isRealPhone } from "../src/context/business-profile.js";

describe("isRealPhone", () => {
  it("accepts real numbers", () => {
    for (const p of ["+48 22 597 69 76", "600 889 645", "+48501749493", "(22) 864-50-03"]) expect(isRealPhone(p)).toBe(true);
  });
  it("rejects template placeholders and fragments", () => {
    for (const p of ["+48 XXX XXX XXX", "+48 xxx-xxx-xxx", "123", "tel: ***", "+48 600 ___ ___"]) expect(isRealPhone(p)).toBe(false);
  });
});
