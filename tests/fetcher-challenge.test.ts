import { describe, it, expect } from "vitest";
import { hasSubstantialContent } from "../src/scraper/fetcher.js";

// A bot-protection interstitial must go to the browser (pelnyparkiet.pl: the whole site became
// "One moment, please..."); real pages, even short ones, stay on the fast static fetch.
describe("static fetch is enough?", () => {
  it("a bot check page (a sentence, a script, no links) -> no", () => {
    const challenge = `<html><head><title>One moment, please...</title><style>body{font:14px sans-serif}</style></head><body><h1>One moment, please...</h1><p>Please wait while your request is being verified...</p><form id="wsidchk-form" method="get"><input type="hidden" id="wsidchk" name="wsidchk"></form><script>(function(){var x=1;document.forms[0].submit();})();</script></body></html>`;
    expect(hasSubstantialContent(challenge)).toBe(false);
  });
  it("a real homepage -> yes", () => {
    const home = `<html><body><nav><a href="/cennik/">Cennik</a><a href="/dj-na-wesele/">DJ na wesele</a></nav><main><h1>Pełny Parkiet - DJ na wesele</h1><p>${"Prowadzimy wesela i imprezy firmowe w Warszawie i okolicach. ".repeat(20)}</p></main></body></html>`;
    expect(hasSubstantialContent(home)).toBe(true);
  });
  it("a short page with links -> yes; an empty app shell -> no", () => {
    expect(hasSubstantialContent(`<html><body><h1>Kontakt</h1><p>Zadzwoń: 600 100 200, pon-pt 9-17, ul. Polna 5, Warszawa.</p><a href="/">Start</a></body></html>`)).toBe(true);
    expect(hasSubstantialContent(`<html><body><div id="root"></div><script src="/app.js"></script></body></html>`)).toBe(false);
  });
});
