import { describe, it, expect } from "vitest";
import { dropRepeatedText } from "../src/context/repeated-text.js";
import type { MarkdownSection } from "../src/scraper/markdown.js";

const sec = (heading: string, content: string): MarkdownSection => ({ heading, level: 2, content, url: "", headingPath: heading ? [heading] : [] });
const MENU = "Torty\n\nCiasta\n\nCiastka\n\nKontakt";
const text = (ss: MarkdownSection[]) => ss.map((s) => `${s.heading}\n${s.content}`).join("\n");

describe("text repeated across a site's pages", () => {
  const product = (name: string, price: string) => [sec("", MENU), sec(name, `symbol:\n${name}-1\n\n${price}\n\ncena za kg`), sec("Stopka", "Zamów mailem\n\nlub telefonicznie\n\n© Firma")];

  it("a run of shared lines stays on the first page only; each page keeps its own text", () => {
    const pages = [product("Sernik", "60 zł"), product("Makowiec", "70 zł"), product("Keks", "80 zł"), product("Piernik", "90 zł"), product("Babka", "50 zł")];
    const out = dropRepeatedText(pages).pages;
    expect(text(out[0])).toBe(text(pages[0]));
    for (const k of [1, 2, 3, 4]) {
      expect(text(out[k])).not.toContain("Ciastka");
      expect(text(out[k])).not.toContain("Zamów mailem");
      expect(out[k].map((s) => s.heading)).toEqual([pages[k][1].heading]);     // menu and footer sections are gone
    }
    expect(out[3][0].content).toBe("symbol:\nPiernik-1\n\n90 zł\n\ncena za kg");
  });

  it("a single shared line between a page's own lines is its label and stays ('symbol:', 'cena za kg')", () => {
    const pages = ["a", "b", "c", "d", "e"].map((n) => [sec(n, `symbol:\n${n}-1\n\ncena za kg\n${n} zł`)]);
    expect(dropRepeatedText(pages).pages).toEqual(pages);
  });

  it("a heading goes only with all of its text; the shared line next to the page's own text stays", () => {
    const pages = ["a", "b", "c", "d", "e"].map((n) => [sec("Opis", `Menu 1\n\nMenu 2\n\nMenu 3\n\nMenu 4\n\nwłasny tekst strony ${n}`)]);
    const out = dropRepeatedText(pages).pages;
    expect(out[2]).toEqual([sec("Opis", "Menu 4\n\nwłasny tekst strony c")]);
  });
  it("a unit line above the footer stays with its price", () => {
    const pages = ["a", "b", "c", "d", "e"].map((n) => [sec(n, `${n} zł\ncena za kg\nZamów mailem\nlub telefonicznie\n© Firma\nTagi`)]);
    expect(dropRepeatedText(pages).pages[4][0].content).toBe("e zł\ncena za kg");
  });

  it("a small site is left as it is; text on a minority of pages too", () => {
    const three = [product("a", "1"), product("b", "2"), product("c", "3")];
    expect(dropRepeatedText(three).pages).toEqual(three);
    const shops = ["x", "y"].map((n) => [sec(n, "Godziny otwarcia\n\npon-pt 8-18\n\nsob 9-14")]);
    const pages = [...["a", "b", "c", "d", "e", "f"].map((n) => [sec(n, `tekst ${n}`)]), ...shops];
    expect(dropRepeatedText(pages).pages).toEqual(pages);
  });
});
