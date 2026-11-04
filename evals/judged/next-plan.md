# Plan for the next iteration (judges' synthesis after iteration 4, 2026-11-04)

Written by the synthesis agent from the 3 judge lenses of iteration 4 (run at 439c2fe). Paths to the session scratchpad no longer exist; the cases and tools are in this folder. Done since: the "About this chat" record states whether the chat is an unclaimed demo (8788cae).

**Iteration 5 plan, from the iteration 4 judges (63 cases, 3 lenses x 4 batches) and the run traces**

**Baseline: iteration 4 (439c2fe)**
- Iteration 4 is iteration 3 plus owner mode, contact details given once, and form fields per order. None of the 12 fixes in the iteration 3 plan was built, so the same causes come back.
- Judge means: accuracy 3.33, customer 3.32, owner 3.22. Iteration 3 was 3.14 / 3.22 / 3.27, so the change is inside the judges' noise of ±0.15.
- 39 of 63 conversations score 3 or less on some lens (iteration 3: 43). 20 have a score of 2 or less. 4 have a 1: djmw-2, romax-2, betonlazy-1, aniatkaczyk-1 (iteration 3: 6). 24 pass all three lenses (iteration 3: 20).
- Blind pairs against iteration 3: new better in 29, old better in 24, even in 10 (verdicts 62-51-13). No real change.
- Judge-free numbers:
  - A new script, loop/srccov.py, measures how many of each case's source pages reach the reply: 0.49 (iteration 3: 0.48). 0.64 become candidates.
  - The 'partial' behaviour was set on 54 of 134 turns.
  - 41 turns had a blocked draft, in 58 rounds (20 unsupported, 20 meta-talk).
- First token: median 3.0 s, p90 4.5 s (iteration 3: 5.1 s). 12 turns took 4.5 s or more (iteration 3: 21). The 4 background-agent turns took 85-244 s.

## Ranked problems (conversations hurt; how many at 2 or less / at 1)

### 1. The page or fact that answers never shapes the reply (17; 8 at 2 or less)
- **Evidence:**
  - romax-1: every candidate was a blog post. The Fort Wola page ("Niedziela (zamknięte)") is in the knowledge base but was never a candidate.
  - sosnowydwor-2: /wesela/ ("W cenę nie wliczony jest alkohol i muzyka") scored 0.43 and the homepage 0.46, both under the 0.5 cut.
  - djmw-3: the homepage FAQ scored 0.91 but Opinie and Konferansjer took the slots.
  - empro-1 T2: no page was used. The current BLACK RED WEEKS page was never a candidate.
  - angelikasolecka-2: the network turn searched only for the 3 missing services, so the FAQ and the price list never became candidates.
  - dworekstaropolski-1 T2: the router did not flag it as a follow-up, so T1's price list was dropped (chat.ts:928 carries pages over only on follow-ups).
  - rentbud-3: the item matcher said "none" although the used page lists Wieża aluminiowa 5m at 120 zł/doba. The injected fact "our price list has no item..." (chat.ts:985) won over the page.
  - empro-2 T1 (in both runs), kwiaciarniamilosc-1 T2 and ostap-1 T2: one failed Jev batch nulled every score (packs.ts:135), so the first 3 search hits were used instead.
  - The fact was in the pack but the reply denied or dropped it after a 'partial' instruction:
    - sweethome-1 T2: 'full' was 0.49, so the reply denied on-site assembly.
    - ostap-3: sent the formwork design to the site manager.
    - kamilkozielewicz-2: left out the 600 zł deposit and the venue inside free travel.
    - helsen-3 and bostabeton-2 T2 (CEM): the same pattern.
  - Also: empro-2, aniatkaczyk-3, liliowa-1.
- **Cause (selection):**
  - All parts are searched as one query (top 20 chunks).
  - Pages are scored against the whole message and only the top 4 at 0.5 or more are kept, within 40k chars.
  - One per-message 'full' score sets 'partial', and the writer then names some detail as missing.
  - 11 of the 14 turns with a meta-talk block were partial or no-info turns.
- **Fix: the split part becomes the unit of the turn.**
  - Split every question turn.
  - For each part:
    - its own search, run in parallel;
    - its own Jev scores;
    - its best page is reserved before the rest of the budget is filled;
    - its matched items, plus the priced items from its used pages.
  - The previous turn's pages are always candidates.
  - Coverage is judged per part. A part is called unanswered only after a second search for it finds nothing.
  - A failed scoring batch keeps the other batches' scores.
- **Verify:** run srccov.py ($0). Replay these 17 cases with run-iter.sh --only (about 40 turns, under $0.10). Targets: a source share of 0.65 or more, 'partial' on 25% of turns or less, and first token no slower.

### 2. Offer items have wrong or missing structure (8; 5; 1)
- **Evidence:**
  - sweethome-3: the "Tort czekoladowy" item came from the flavour listing. It has the neighbouring item's code (SH-3006) and no price.
  - sweethome-1: every wedding cake shows "- PLN" because the K1/K2/K3 per-kg legend is not resolved. SH-1122's 9 kg minimum is ignored.
  - kwiaciarniamilosc-2: the wreath has a price range of 1090-2589 zł and sizes "King Size, Large, Medium", but no price per size. The check therefore blocked the correct "od 1090 = najmniejszy". The sash (+60 zł) and delivery are not on the item.
  - angelikasolecka-3: the 200 zł/h item (minimum 2 h) was quoted as "price on request".
  - dworekstaropolski-1: the item reads "próg nie podany"; the condition of more than 85 adults, otherwise 2000 zł, was lost.
  - bostabeton-1: the item carries "do 40 km", taken from the TransMix page.
  - romax-2: unpriced category items were chosen over priced Quick-Step panels.
  - zajacfoto-3: the foto+video package delivered with a partner is not recorded as the business's own item.
- **Cause (data):** items are extracted per page without being checked against that page.
- **Fix: audit each price page at ingestion (iteration 3 fix 3).**
  - An LLM reads each price-bearing page together with its items (by id).
  - It returns as structure:
    - price, unit and minimum;
    - legend codes resolved;
    - variants with their visible labels and prices;
    - add-ons;
    - conditional tiers;
    - which items a note applies to;
    - services delivered by a partner, recorded as the business's own;
    - attributes not on that page removed.
  - Code applies the corrections by id.
- **Verify:** run offline on these 7 tenants (about $0.05) and diff the named items. Then replay about 12 price turns.

### 3. The business's own products go to the background calculation or to competitors (6; 4; 2)
- **Evidence:**
  - djmw-2 (owner score 1): 125 s; Pełny Parkiet priced inside DJMW's own quote; included services taken from a market FAQ; a .csv file named.
  - betonlazy-1 (owner score 1): 186 s for 8,1 m³; Bosta Beton asked to quote B20, which Łazy sells itself; a file path shown.
  - betonlazy-3: nothing after 243 s, then T2 says "Zapisaliśmy dane" and "nie mogę przekazać".
  - bostabeton-2 T3: 85 s, ending in "being approved", with no contact.
  - bostabeton-3: offered the network for smaller loads of its own HydroBeton ("ours" 0.79 against the 0.8 cut).
  - zajacfoto-3: the business's own partner package went to the network.
- **Cause (routing):**
  - Jev gates over loose passages decide the route: formOffered, hasPrices, simple/allOurs, ours ≥ 0.8.
  - A `/\d/` test on customer text also decides (chat.ts:779), which breaks the no-regex-on-text rule.
  - Agent rule 9 asks businesses in the same trade to quote.
- **Fix: decide coverage from structure (iteration 3 fix 2).** The item matcher's own picks decide:
  - parts that match the host's items stay with the host:
    - priced: computed in the chat;
    - unpriced: answered in the chat with the computed quantity, "no published price" and the right contact or form;
  - the agent runs only for priced multi-step work;
  - only parts the host does not cover go to the network or the agent;
  - the regex goes.
- **Verify:** run routetest.mjs on these first messages plus controls (romax-3 windows, ostap-3 concrete, sosnowydwor-2 DJ, liliowa-3 balloons), about $0.01. Target: no agent or network start for parts the host covers.

### 4. The knowledge base is built from the wrong pages (8; 5)
- **Evidence:**
  - kwiaciarniamilosc-1 and -2: only 19 pages were read, 14 of them EN/UK copies. /regulamin/, /dostawa-i-platnosc/, /kwiaty-z-dostawa-warszawa/ and /florystyka-funeralna/ were never read. They are in its sitemap or menu, and all of them return 200 to WhispBot.
  - sweethome-1 and -3: the 150-page cap for demos was used up before any of the 6 wedding-cake pages; 17 muffin pages were read instead.
  - dworekstaropolski-3: 27 of 56 pages are /en/ copies. The old English page (140 zł) beat the Polish /nocleg-poznan/ (220 zł).
  - liliowa-1: 41 of 59 pages are ?start=N gallery copies.
  - kamilkozielewicz-2: 8 URLs come back twice, with and without "/" (old vectors left from an earlier scrape).
  - zajacfoto-3: the 80-question FAQ is a single page, scored 0.11.
- **Fix: build page units from structure at ingestion.**
  - Group copies (hreflang/canonical, rel=next or pagination, slash/www variants) and keep one primary per group.
  - Read sitemap, menu and footer pages first. A check after the crawl fetches any that are missing. Under the page cap, take product pages in turn from each parent listing.
  - An LLM splits FAQ and terms pages into their sections.
  - The query keeps only URLs in the current site map.
- **Verify:** an offline crawl report for these 6 tenants (about $0.02). Re-scrape them while the queue is empty, replay the 8 cases and run srccov.py.

### 5. Ended promotions and changed prices are given as current (4; 4; 2)
- **Evidence:**
  - romax-2: on 4.11 it said "w tej chwili jest aktualna" about a promotion that ended on 31.10.
  - empro-1: offered expired promotions instead of BLACK RED WEEKS.
  - aniatkaczyk-1: the items were read on 2026-10-31; the page changed on 2026-11-03 to 3000/4200 zł.
  - kwiaciarniamilosc-1: the Mother's Day 2026 page was used.
- **Fix: dated data (iteration 3 fix 7).**
  - The LLM stores validity (from-to, or the list's period) for every page and item.
  - Code compares it with today and with the customer's date: ended items are dropped or marked "ended <date>".
  - A daily lastmod/ETag/hash check re-reads price pages that changed.
- **Verify:** a validity report for 5 tenants (about $0.02). After re-reading aniatkaczyk, Komfort must show 3000 zł. Replay the 4 cases.

### 6. Flagged claims still go out, and correct ones become hedges (9; 4; 1)
- **Evidence:**
  - Sent although flagged:
    - romax-2: "netto + VAT", blocked twice;
    - dworekstaropolski-1: 60 guests in a 50-guest hall;
    - also ostap-2, ostap-3 and sweethome-1, plus whisp-3 (which still passes): "including Wix".
  - Correct claims blocked:
    - kwiaciarniamilosc-2: "od 1090 = najmniejszy";
    - whisp-1: 1788 zł was blocked because the quote said 13 months;
    - sweethome-3 and angelikasolecka-2: claims that described what the chat really does.
- **Cause (checks):** after round 2 the last draft goes out whatever its verdict. The rewrite gets the reason but not the evidence. The check does not see the writer's items, quote or state.
- **Fix: blocked statements become turn state (iteration 3 fix 5).**
  - Each flagged statement carries its best-ranked pack sentences.
  - It is re-tested every round and is never sent. After round 2, a delete-only edit removes it and is checked again.
  - The check reads the same items, quote and state record (fix 8) as the writer.
- **Verify:** replay these 10 turns. Targets: no draft sent with an open block, the 4 false blocks pass, rewrite rate at 31% of turns or less.

### 7. Site-wide terms and contact roles are missing from the business profile (10; 5, mostly together with other causes)
- **Evidence:**
  - dachywarszawa-3: the NIP is only in the privacy policy, so the chat said "NIP nie jest podany".
  - empro-2: payment methods, dispatch time and free shipping from 500 zł are missing.
  - dachywarszawa-2: "free estimate" is missing. whisp-1: "billed monthly, cancel any time" is missing.
  - bostabeton-1, -2 and -3: the office line is given instead of sales (+48 22 50 80 990).
  - empro-3: phone numbers regrouped ("+48 57 085 48 54").
  - romax-1 and sweethome-1: the wrong line for the salon or for weddings.
  - "Contact once per conversation" (77d14c9) dropped needed lines in kamilkozielewicz-1 T3 and bostabeton-2 T3.
- **Fix:** the LLM profile extractor also stores:
  - legal identity (also read from legal pages);
  - standing terms: payment, prepayment, dispatch, free-shipping threshold, free estimate, service area;
  - each contact with its role or branch and its displayed text.

  "Contact given" is tracked per contact, not per conversation.
- **Verify:** run offline on all 21 tenants (about $0.05) against a list of expected values, then run ownertest.mts.

### 8. Orders and inquiries contradict themselves and use a generic form (6; 3)
- **Evidence:**
  - angelikasolecka-1 T2: the check blocked both "zapisałam dane" and "only information here". The sent reply mixes both and asks again for the name and e-mail just given.
  - sweethome-3: "Mogę przyjąć zamówienie", then "nie mogę potwierdzić".
  - betonlazy-3 T2: the same contradiction.
  - kamilkozielewicz-2: a photographer's summary has "Miejsce lub adres dostawy" and raw customer text in the notes.
  - rentbud-3 T2: the e-mail landed in "Telefon", and there were no Saturday hours and no 2 doby = 240 zł, because form turns retrieve no pages.
  - insanit-2: the customer was shown a third-person ticket, and "popołudniami" was dropped.
- **Cause (state):**
  - The prompt says "this chat can only answer" (chat.ts:1086).
  - Every business gets the same generic goods-order form (collect-store.ts).
  - Values are copied raw.
- **Fix: one inquiry state record per conversation (iteration 3 fixes 8 and 9), given to the writer and the check.** It holds:
  - whether this chat can take the order or inquiry;
  - the business's own form fields, derived once from its offer type, with e-mail and phone typed separately;
  - the values, the missing fields and the stage;
  - the calculation status.

  Form turns also get the pack. The "can only answer" clause goes.
- **Verify:** replay T1-T2 of the 6 cases. Targets: no contradiction (one Jev question against the record), nothing asked twice, no e-mail in a phone field.

### 9. The quote stops short of what was asked (5; 2 at 1)
- **Evidence:**
  - whisp-1: a year became 13 months (recipe.ts:133 counts a month as 720 h).
  - aniatkaczyk-1: Komfort was quoted for 6 services although it covers 5.
  - zajacfoto-1: the cheaper Standard + plener total (6500 zł) was not computed.
  - liliowa-1: no total across turns.
  - djmw-2: the deposit was only offered, and the 10 h standard was exceeded without saying so.
- **Fix: the quote returns full structure computed by code (iteration 3 fix 6).**
  - Durations in the price's own unit.
  - Package capacity against the units asked, with extension lines.
  - A total for each sibling tier.
  - Deposit and remainder.
  - Scope beyond the standard marked "no rate on the site".
  - A running total across turns.
- **Verify:** unit tests on these 7 requests ($0), then replay the price turns.

### 10. Owner demo probes, the salesperson's opening (5 of 7 probes fail; 3 at 2 or less)
- **Evidence:**
  - empro-3: the owner was never detected ("NIP mojej firmy" got "a nie Pana/Pani").
  - dachywarszawa-3: detected only at T3.
  - bostabeton-1 and helsen-2: the "About this chat" record says "the Whisp chat on the website of X". The replies turned it into "prowadzony przez firmę" and "dane wprowadzone przez właściciela w panelu", on demos nobody has claimed.
  - bostabeton-1 T3 and liliowa-3 T3 ("what would you tell a customer..."): answered in owner mode, with no network.
  - liliowa-3: "Pani Magdo" was taken from the e-mail address.
- **Fix: owner mode built from state.**
  - The router judges the speaker's role over the whole conversation, with the tenant's state (unclaimed demo or live) as context.
  - The record states the real state: demo built from N pages read on a given date, not installed, owner answers so far.
  - When the owner asks "what would a customer get for X", X runs through the customer pipeline.
- **Verify:** run ownertest.mts on the 7 probes (about $0.01).

### 11. Slow first word on price turns (12 turns in 10 conversations)
- **Evidence:**
  - aniatkaczyk-1 T1, 9.4 s: two quote-read calls (3.1 + 3.0 s) run one after the other before the search starts.
  - romax-2 T1: 13.6 s in total, with 2 rewrites.
  - angelikasolecka-3 T1: 5.9 s.
- **Fix:** start retrieval, item matching and coverage at routing time, in parallel with the quote read.
- **Verify:** from run.json steps. Targets: p90 first token 4.0 s or less, aniatkaczyk-1 T1 6.5 s or less.

### 12. Network businesses described by what they only sell (2; 1)
- **Evidence:**
  - angelikasolecka-2: the florist floli.pl was presented as a beauty salon, with the florist's phone.
  - ostap-3: Bosta Beton was listed for concrete with a pump.
- **Fix:** the capability index (LLM) tags each capability as done by the business itself or only sold or mentioned. Only the first kind is indexed.
- **Verify:** rebuild the index for those two firms and re-run the 2 turns (about $0.01).

### 13. Language and form-of-address slips (about 10 conversations, low impact)
- **Evidence:**
  - Mixed-alphabet "recepцію" (dworekstaropolski-2).
  - "cuisine" for a pâtisserie (sweethome-2).
  - Polish words inside Ukrainian replies (dachywarszawa-2).
  - "conférencier" (djmw-3).
  - "Pan/Pani" slash forms and ty/Pani switches.
- **Fix:** extend the alphabet check to a word-level Jev check, and keep the form of address as conversation state.
- **Verify:** one Jev pass over all replies.

## Works well; must not break
- **Regression set:** these 24 conversations pass all three lenses: aniatkaczyk-2, betonlazy-2, dachywarszawa-1, djmw-1, helsen-1, insanit-1, insanit-3, kamilkozielewicz-1, kamilkozielewicz-3, kwiaciarniamilosc-3, liliowa-2, ostap-1, pelnyparkiet-1, pelnyparkiet-2, pelnyparkiet-3, rentbud-1, rentbud-2, romax-3, sosnowydwor-1, sosnowydwor-3, sweethome-2, whisp-2, whisp-3, zajacfoto-2.
- **Sums computed by code in the chat:**
  - dworek 17 100 zł;
  - zajacfoto 7000 zł;
  - angelikasolecka 230 / 330 zł;
  - romax 4030,40 zł;
  - empro 2097 zł;
  - betonlazy 8,1 m³;
  - bostabeton 2,5 / 3,7 m³ against its 4 m³ minimum;
  - liliowa 120 zł;
  - aniatkaczyk-2 915,99 zł;
  - sosnowydwor-1 18 085 zł.
- **Honesty:**
  - "no published price" with the business's own contact;
  - no date or availability promised in any case;
  - "nothing was sent" after every withdrawal.
- **Other basics:**
  - replies in EN, FR, UK and DE from Polish pages;
  - network businesses shown as separate firms with their own contacts;
  - exact NIP/KRS when they are on the contact page;
  - the order summary and confirm step;
  - owner mode where it is detected (djmw-1, kwiaciarniamilosc-3).
- **Iteration 3 replies to make stable** (they beat iteration 4 in the blind pairs):
  - bostabeton-2: suggested CEM for the shower;
  - rentbud-3: quoted the tower at 120 zł/doba;
  - sweethome-1: gave K2/K3 per kg and on-site assembly;
  - sosnowydwor-1: gave the new total;
  - empro-1: said "free shipping applies";
  - ostap-3: said Ostap designs the formwork set.

## Owner decisions needed
1. **Agent rule 9 (the 2026-10-20 position):** the network is asked to price the business's own unpriced products. All three lenses score this lowest (djmw-2 and betonlazy-1 get an owner score of 1). Fix 3 needs the rule "the business's own items stay in the chat".
2. **Calculations held for approval on demos nobody has claimed** never arrive (betonlazy-3, bostabeton-2). Either no agent on demos, or results released automatically on demos.
3. **Demo cap of 150 pages (ONBOARD_MAX_PAGES):** sweet_home, romax and angelikasolecka hit it. Fix 4 orders the crawl within the cap; the alternative is a higher cap for demos created by a salesperson.
4. **Hold replies until checked:** still undecided.

## Order and cost
1. **First push, small code fixes from the traces:**
   - packs.ts:135 keeps partial scores;
   - chat.ts:928 always carries the previous turn's pages;
   - drop candidate URLs that are not in the current site map;
   - chat.ts:985 adds the "no item" fact only when no used page has priced items;
   - remove the chat.ts:779 regex;
   - fix 11.
2. Fixes 3 (after decision 1), 1, 8 together with 6 (they share the state record), 10 and 9.
3. Data fixes 4, 2, 5 and 7 in one re-extraction of the 21 tenants, after the last push and with the re-scrape queue empty.
4. Fixes 12 and 13.

For each fix, run one case and read it before its group. Offline and unit checks cost under $0.2. Finish with one full 63-case run with blind pairs, about $0.3 of OpenRouter plus Jev; check both balances first.

**Files** (the worktree with the loop's commits, plus the new metric script):
- /Users/kubal/Desktop/projects/website-context-packs/src/llm/chat.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/llm/packs.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/llm/router.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/offer/search.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/offer/store.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/offer/recipe.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/pricing/model.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/scraper/crawler.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/scraper/catalogue.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/flows/collect.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/flows/collect-store.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/projects/agent.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/context/business-profile.ts
- /private/tmp/claude-501/-Users-kubal-Desktop-projects-website-context/033ece33-52c7-4242-8df4-d3e70a359336/scratchpad/loop/srccov.py