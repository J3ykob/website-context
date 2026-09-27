import { describe, it, expect } from "vitest";
import { parseEnrichJSON } from "../src/context/store.js";

describe("parseEnrichJSON", () => {
  it("parses a normal reply and dedupes keywords", () => {
    const r = parseEnrichJSON('{"summary":"Godziny otwarcia placówki na Targówku","keywords":["godziny","Godziny","opening hours","Targówek"]}');
    expect(r).toEqual({ summary: "Godziny otwarcia placówki na Targówku.", keywords: ["godziny", "opening hours", "Targówek"] });
  });
  it("salvages a reply truncated while looping on keywords", () => {
    const r = parseEnrichJSON('{"summary": "Rodzaje badań do pracy w Lublinie.", "keywords": ["badania", "Lublin", "medycyna pracy", "badania", "Lublin", "medycyna pracy", "bad');
    expect(r).toEqual({ summary: "Rodzaje badań do pracy w Lublinie.", keywords: ["badania", "Lublin", "medycyna pracy"] });
  });
  it("never invents a summary", () => {
    expect(parseEnrichJSON('{"keywords":["a","b","c"]}')).toBeNull();
    expect(parseEnrichJSON('{"summary": "Cut mid-sent')).toBeNull();
  });
});
