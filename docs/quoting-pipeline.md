# Quoting pipeline (state 2026-11-01)

How a customer's request becomes a correct price, end to end. Owner's rule throughout: a model turns
text into structure and structure into text; code only moves structure to structure (code never reads or
matches text). Every limit below has a row in docs/limits.md.

## 1. Scrape - the business's pages as clean text (every scrape)

| Step | What happens | Code |
|---|---|---|
| Crawl | sitemap first, then links; a start page with no links to its own site is fetched again in a real browser (bot checks served to our servers); if it still links nowhere it is retried at the end and not kept as the home page; throttled hosts slow down and give up after 12 throttles | src/scraper/crawler.ts |
| Page text | the page as text blocks in reading order; inline words stay in their sentence ("W cenę **nie wliczony** jest alkohol" - the bold words used to be moved out, which read as "alcohol included"); line breaks separate words | src/offer/index-scrape.ts textBlocks |
| Offer pages | a model judges which pages show products, services or prices; each is read in 6000-char windows overlapping 500, up to 24000 chars | src/offer/index-scrape.ts |
| Offer items | items with prices extracted, each item and its prices confirmed against the page by a model | src/offer/extract.ts confirmItems |
| Kept | the offer pages' text saved to R2 `tenants/<id>/offer-pages.json` (input of step 2) | src/multi-tenant/scrape-pipeline.ts |

## 2. Build - the business's quoting model (once; again only when its pages change)

1. **Parts.** Offer pages split into parts of up to 40000 chars (PRICING_MAX_PARTS, default 12; 4 keeps
   big sites to about an hour). Pages about terms for every offer (delivery, deposits, discounts) go into
   every part.
2. **Program.** A model with reasoning (Opus 5.5) writes one JavaScript program per part:
   `catalog` (items, each with the inputs its price needs, shared inputs like guests or distance),
   `needs(request)` and `quote(request)`. Generation rules (src/pricing/model.ts GENERATE), all general:
   - only prices the pages state; a missing price = "on_request", never invented;
   - statuses exactly price / range / needs / on_request / not_offered / included ("included" = priced
     inside another item, never 0);
   - an unchosen option -> range over the options; "needs" only when no price is possible;
   - a price that holds under a condition -> the price with the condition, not a question;
   - a way of paying (hourly vs daily) is not an input - the cheapest for the customer;
   - one input per quantity in one unit; an item covering a fixed amount (5 h, 100 guests) takes the
     customer's amount as an input so it can tell whether it covers it;
   - packages vs singles -> the cheapest combination that covers the need.
3. **Checks.** A second model (Sonnet 5.5) writes 8-12 cases from the pages alone (message + expected
   statuses and amounts); the program runs them in QuickJS (32 MB, 200 ms); disagreements go back to the
   generator, up to 2 rounds. A contract check verifies the output shape.
4. **Completeness.** A model compares the catalogue (with each item's options and note) against the offer
   items from step 1; a part with real gaps is rebuilt once with the gaps named.
5. **Saved** to R2 `tenants/<id>/pricing.json` with a hash of the pages - a rebuild only when it changes.

Who builds: today the Claude Code CLI on the Mac or the VPS (scripts/pricing-build-local.ts, one-off jobs on
the owner's subscription - never its token in our servers); the admin route POST /api/admin/pricing/:id
and PRICING_BUILD=on (every scrape) use the API model.

Built so far (wedding network, from clean text): Sosnowy Dwór 61 items, Ania Tkaczyk 57, Angelika Solecka
181, Pełny Parkiet 16, DJ MW 55, Zając Foto 33, Kozielewicz 20, Sweet Home 1469, Dworek Staropolski 204,
Sala Onesto 34, Liliowa 8; checks 8/12-144/144 agreeing. Rentbud 249 (from older text). The two florists
have no offer pages (shops read from their catalogue) - no model yet.

## 3. Quote - every customer message that asks a price

1. **Read** (text -> structure, Haiku 5.5): the conversation as a request in the catalogue's own terms -
   needs, each with the items that could cover it (options), and the inputs the customer gave. Only
   catalogue ids are kept; a catalogue over 60000 chars is shown one line per item.
2. **Quote** (structure -> structure, code): each part's program runs in QuickJS; lines are grouped by
   need, the cheapest priced option counts in the total, the others are marked alternatives; a
   not-offered alternative is left out.
3. **Facts** (structure -> text by fixed formatting): one line per item with its status and note, plus
   "each amount already includes what its note lists" and the total of the cheapest options.

Where the quote is used (PRICING_CHAT=on, or test variant "pricing"; off in production until the runs pass):

- **Chat, own business:** the quote replaces the old recipe computation in the reply's facts.
- **Chat, network businesses** relayed to the customer: each prices the request with its own model.
- **Project agent:** each business with a model gives `cenniki/wycena_<firma>.md` instead of its
  price-list rows (two sources disagreed and the agent took the stale row).

## 4. Routing around it (chat)

- Our own answer first.
- The customer asks for recommendations -> the network businesses join our own answer.
- Our information covers the topic but not the detail, and the network search already has businesses
  for it -> offer to check the network; on "yes" it searches and recommends with prices.
- Otherwise the offer to pass the question to the team, as before.

## 5. How it is tested

1. Smoke on one case, inspect the output, only then the batch.
2. Chain tests (tests/network-chain.test.ts) on the VPS (~/wc-bench, credentials copied in and removed on
   exit): 8 wedding cases x 3 runs, 13 construction cases.
3. A judge model grades every reply; every non-correct verdict is read by hand against the business's
   current pages - the judge errs both ways (it marked real prices invented when its data was older).
4. Ground truths carry the date of the data they were checked against.

Results: wedding baseline 7/24 correct (judge). With the pipeline, hand-read: 16/24 (2026-11-01 night),
then 7/8 in the first run after the routing fixes (runs 2-3 pending).
