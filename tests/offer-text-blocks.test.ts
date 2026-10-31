import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { textBlocks } from "../src/offer/index-scrape.js";

// The offer pages' text must keep inline words in their sentences - bold text is often the important word.
describe("offer page text blocks", () => {
  it("bold / links stay inside their sentence (Sosnowy Dwór: 'nie wliczony' was moved out - the opposite meaning)", () => {
    const $ = cheerio.load(`<body><p>Pokój dla Młodej Pary (w cenie)</p><p>W cenę <strong>nie wliczony</strong> jest alkohol i muzyka. Zobacz <a href="/cennik">cennik</a> sali.</p></body>`);
    expect(textBlocks($)).toEqual(["Pokój dla Młodej Pary (w cenie)", "W cenę nie wliczony jest alkohol i muzyka. Zobacz cennik sali."]);
  });
  it("lists and tables: one block per item / cell, in order", () => {
    const $ = cheerio.load(`<body><ul><li>Tort <em>weselny</em></li><li>Owoce</li></ul><table><tr><td>Koszty powyżej 100 osób</td><td>– <b>200</b> zł</td></tr></table></body>`);
    expect(textBlocks($)).toEqual(["Tort weselny", "Owoce", "Koszty powyżej 100 osób", "– 200 zł"]);
  });
  it("loose text next to child blocks is kept, around them", () => {
    const $ = cheerio.load(`<body><div>Cena od <strong>150 zł</strong><p>za osobę</p>brutto</div></body>`);
    expect(textBlocks($)).toEqual(["Cena od 150 zł", "za osobę", "brutto"]);
  });

  it("a line break separates words", () => {
    const $ = cheerio.load(`<body><p>wynajem pokoi.<br>Posiadamy 7 pokoi<br/>w cenie 50 zł</p></body>`);
    expect(textBlocks($)).toEqual(["wynajem pokoi. Posiadamy 7 pokoi w cenie 50 zł"]);
  });
});
