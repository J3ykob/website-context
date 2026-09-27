import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { buildLinkIndex, guardLinks } from "../src/llm/link-guard.js";

// Real page list (url + title) from the www.amygdala.pl crawl, 2026-09-27.
const pages = JSON.parse(readFileSync(new URL("./fixtures/amygdala-pages.json", import.meta.url), "utf8"));
const index = buildLinkIndex(pages)!;
const S = "https://www.amygdala.pl";
const fix = (href: string) => guardLinks(`[Strona](${href})`, index).text;

describe("guardLinks on the six broken links the bot produced in production", () => {
  it("Polish letters in a slug -> the real page", () => {
    expect(fix(`${S}/badania-na-broń/`)).toBe(`[Strona](${S}/badania-na-bron/)`);
    expect(fix(`${S}/psycholog-biegly-sądowy/`)).toBe(`[Strona](${S}/psycholog-biegly-sadowy/)`);
  });
  it("typos in a long slug -> the real page", () => {
    expect(fix(`${S}/konsultacja-psychiatriczna/`)).toBe(`[Strona](${S}/konsultacja-psychiatryczna/)`);
    expect(fix(`${S}/nowa-forma-orzeczen-lekarszych-e-orzeczenia-od-17-pazdziernika/`)).toBe(`[Strona](${S}/nowa-forma-orzeczen-lekarskich-e-orzeczenia-od-17-pazdziernika/)`);
  });
  it("slug built from a page title -> the page with that title", () => {
    expect(fix(`${S}/badania-okulistyczne-do-pracy-warszawa/`)).toBe(`[Strona](${S}/okulista/)`);
    expect(fix(`${S}/medycyna-pracy-warszawa-i-online/`)).toBe(`[Strona](${S}/)`);
  });
});

describe("guardLinks keeps good links and removes invented ones", () => {
  it("leaves real pages, with or without trailing slash", () => {
    expect(fix(`${S}/cennik/`)).toBe(`[Strona](${S}/cennik/)`);
    expect(guardLinks(`[Cennik](${S}/cennik)`, index).text).toBe(`[Cennik](${S}/cennik/)`);
  });
  it("drops an on-site link to a page that does not exist, keeping the text", () => {
    const r = guardLinks(`Zobacz [nasz rezonans](${S}/rezonans-magnetyczny-glowy/).`, index);
    expect(r.text).toBe("Zobacz nasz rezonans.");
    expect(r.dropped).toBe(1);
  });
  it("does not touch other domains", () => {
    expect(fix("https://example.com/x")).toBe("[Strona](https://example.com/x)");
  });
  it("fixes bare on-site URLs too", () => {
    expect(guardLinks(`Więcej: ${S}/badania-na-broń/.`, index).text).toBe(`Więcej: ${S}/badania-na-bron/.`);
  });
});
