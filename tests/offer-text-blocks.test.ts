import { describe, it, expect } from "vitest";
import * as cheerio from "cheerio";
import { textBlocks, createOfferIndexer } from "../src/offer/index-scrape.js";

// The offer pages' text must keep inline words in their sentences - bold text is often the important word.
describe("offer page text blocks", () => {
  it("bold / links stay inside their sentence (Sosnowy Dwór: 'nie wliczony' was moved out - the opposite meaning)", () => {
    const $ = cheerio.load(`<body><p>Pokój dla Młodej Pary (w cenie)</p><p>W cenę <strong>nie wliczony</strong> jest alkohol i muzyka. Zobacz <a href="/cennik">cennik</a> sali.</p></body>`);
    expect(textBlocks($)).toEqual(["Pokój dla Młodej Pary (w cenie)", "W cenę nie wliczony jest alkohol i muzyka. Zobacz cennik sali."]);
  });
  it("lists and tables: one line per list entry / table row, cells joined, in order", () => {
    const $ = cheerio.load(`<body><ul><li>Tort <em>weselny</em></li><li>Owoce</li></ul><table><tr><td>Koszty powyżej 100 osób</td><td>– <b>200</b> zł</td></tr></table></body>`);
    expect(textBlocks($)).toEqual(["Tort weselny", "Owoce", "Koszty powyżej 100 osób | – 200 zł"]);
  });
  it("a product tile's name and code stay on one line (flat, every name read the code of the tile before it)", () => {
    const tile = (name: string, code: string) => `<li><div class="t"><a href="#"><img alt="${name}"><div>${name}<br/><font>kliknij na zdjęcie</font></div></a><div class="d"><div> ${code}</div></div></div></li>`;
    const $ = cheerio.load(`<body><ul>${tile("Piernik staropolski", "SH-6922")}${tile("Ciasto czekoladowo-piernikowe", "SH-6900")}</ul></body>`);
    expect(textBlocks($)).toEqual(["Piernik staropolski kliknij na zdjęcie | SH-6922", "Ciasto czekoladowo-piernikowe kliknij na zdjęcie | SH-6900"]);
  });
  it("a list entry that holds a whole text is not squeezed into one line", () => {
    const long = "Bardzo długi opis usługi. ".repeat(10).trim();
    const $ = cheerio.load(`<body><ul><li><h3>Usługa</h3><p>${long}</p><p>${long}</p></li></ul></body>`);
    expect(textBlocks($)).toEqual(["Usługa", long, long]);
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

// Live: a cake shop shows the price and its unit in read-only fields of the order form, and lists products
// as tiles (name, then code). The price list said "SH-6922, no price" for the cake that is SH-6900, 48 zł.
describe("offer page text on a real shop", () => {
  const html = async (u: string) => (await fetch(u, { headers: { "user-agent": "Mozilla/5.0 (compatible; whisp-test)" } })).text();
  it("product page: code, shown price and unit; listing: each name with its own code", async () => {
    const idx = createOfferIndexer();
    const product = "https://www.sweet-home.pl/1005,Ciasto-czekoladowo-piernikowe.html", listing = "https://www.sweet-home.pl/24,Wypieki-na-swieta-i-inne-okazje.html";
    idx.addPage(await html(product), product);
    idx.addPage(await html(listing), listing);
    const [p, l] = idx.pageTexts();
    expect(p.text).toMatch(/symbol: SH-6900\n\d+,- zł\ncena za 1 szt\./);
    expect(p.text).not.toContain("Szukaj");
    expect(l.text).toMatch(/^Ciasto czekoladowo-piernikowe [^|\n]*\| SH-6900$/m);
    expect(l.text).toMatch(/^Piernik staropolski [^|\n]*\| SH-6922$/m);
  }, 60000);
});
