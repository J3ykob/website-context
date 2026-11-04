# Business Record: design

Design document, 2026-11-04. Repository `website-context-packs`, branch `packs` (production main), code at d91e00f. Evidence comes from `evals/judged/` (README.md, next-plan.md, cases/*.json) and from the code. None of this is built yet.

## Summary

Today the chat answers from three sources:
- whole pages picked per turn ("packs");
- a five-field contact profile with up to 5,000 characters of raw contact text;
- offer items that an LLM reads from 6,000-character windows.

Four judged iterations show this pipeline has stopped improving. In the last blind pairs the new version won 29, lost 24 and tied 10. The remaining errors are mostly in the data:
- the page that answers was never read, or never selected;
- items lost their structure;
- ended promotions look current;
- business-wide terms have no place to live.

This design builds one **Business Record** per tenant from its public pages:
- **Code** splits every page into blocks from its DOM: heading path, tab label, table columns, region. It also groups copies, translations, pagination and older versions.
- **An LLM** reads each primary page into entities and claims. Every value cites the blocks it came from and carries its condition and validity.
- **Jev** checks each claim against only the blocks it cites.
- **Code** then:
  - joins entities;
  - computes each value's status against today (current, future, ended, superseded);
  - ranks conflicting values;
  - records what the site does not state;
  - publishes the record.
- **The owner's corrections** are claims that outrank the site.

Everything reads the same record:
- the chat: an always-present card, plus checked lines for each part of the question;
- the item matcher;
- the quote program;
- the order form;
- the network index;
- the owner's panel "Co wie Twój czat".

The record also writes today's files (offer.json, officialInfo, offer-pages.json, capability records). Code that does not know the record keeps working.

Cost and calls:
- Per turn, no new kind of call is added, and up to three Jev calls go away.
- A build costs about **$0.20 per million characters** of page text read: about $0.007 for the median of the 26 local tenants, $0.06 on average.
- After that, only changed pages are read again.

Rollout is behind a per-tenant switch (off, shadow, on):
1. one tenant, read by hand;
2. the 21 eval tenants offline, against expected facts;
3. a shadow build in production;
4. a targeted reply test;
5. one 63-case milestone with blind pairs.

---

## 0. Basis

### 0.1 The designs compared

Three judges scored four designs. Each cell shows one score per judge:

| Design | Accuracy impact | Feasibility / cost | Owner's rules | Owner value |
|---|---|---|---|---|
| data - span-grounded, dated claims | 4.5 / 4.5 / 4.5 | 3 / 3 / 3 | 5 / 5 / 4.5 | 4 / 4 / 4 |
| use - card, item cards, turn reader | 4 / 4 / 4 | 2.5 / 3 / 3 | 4.5 / 4.5 / 4 | 4 / 4 / 4 |
| owner - record behind the owner's panel | 3.5 / 3.5 / 4 | 2.5 / 4 / 3 | 4.5 / 4.5 / 5 | 5 / 5 / 5 |
| scale - content-addressed page readings | 3 / 3.5 / 3.5 | 3.5 / 3.5 / 3.5 | 4 / 4 / 4 | 3 / 3 / 2.5 |

This document builds on **data**, which scored best on accuracy and on the owner's rules. It takes these ideas from the others.

**From use:**
- coverage labels per part of the question, routed by code;
- computed lines in code: capacity and extension, durations in the price's own unit, minimums, deposit and remainder, thresholds, season rows, a running total;
- FAQ answers, exclusions and "not stated" topics as entries the chat can pick by id;
- the full list of code that reads customer or page text, so it can be deleted;
- a per-trade checklist of standard topics;
- "not in our offer" only when the whole offer was read.

**From owner:**
- the verification question "about this business itself - not a partner, an example or general advice";
- a named ended item comes back as "ended on <date>";
- a `stale` question and per-contact `gave_<id>` questions inside the existing check call;
- demand counted per slot from real turns;
- the panel flow: attention list, one-tap actions, typed edits, "Twoimi słowami" with an LLM read-back, a first-login check;
- the demo drawer, with sales hooks only behind the demo pass;
- clean() extended first;
- candidate pages outside the record's page set dropped;
- the business's own inquiry form;
- a separate Jev key and a build budget;
- atomic publish.

**From scale:**
- readings cached by content and shared across builds and tenants. Offline readings become production cache hits, and a build killed by a push resumes.
- page hashes persisted;
- chunk labels reused by chunk id on re-scrape;
- rollout in waves, with a cost per wave;
- a size basis measured on the 26 local tenants: 1,425 pages and 8,170,891 characters of page text.

### 0.2 Flaws the judges found, and where this design fixes them

**Flaws in the base design:**

| Flaw | Fix | Where |
|---|---|---|
| FAQ entries and exclusions had no path to a reply (djmw-3, sosnowydwor-2) | FAQ answers, exclusions and "not stated" topics are entries in the matcher's index, picked by id in the existing call | 4.3 |
| Ended values were dropped even when the customer names them (romax-2 T2) | Ended entries stay in the index for 60 days, labelled. A named one comes back as an "ended on <date>" line. The check call gets a `stale` question | 4.4, 4.9 |
| Terms reached the prompt only through new router questions; the card held only identity and contacts | Headlines of current standing terms go on the card. Full terms come through selection. The router does not change | 4.8 |
| The failed-batch null in scorePacks (packs.ts:135) and the per-part search were not fixed | Partial scores are kept. Every part without a record entry gets its own search | 4.7 |
| Strict verification drops true values. Only some claim families got a repair round. The K2 legend could be rejected | Every rejected claim gets one repair round. Code derives a legend from items that share a code and a price. Rejected claims are listed in the panel. Shadow mode keeps today's extractor until recall is measured | 3.6, 3.7, 7 |
| Problem 9 was handled only indirectly; recipe.ts:133 counts a month as 720 h | arith.ts computes on structure. Prices per month are counted in months | 4.6 |
| The fleet cost left out the re-scrape. Jev ran on the production key | The re-scrape cost is stated. Chunk labels are reused by chunk id. Builds use JEV_BUILD_API_KEY, OPENROUTER_BUILD_KEY and a daily build budget | 6.4, 3.10 |
| Windows chained by entity ids cannot run 16 at once | 16 pages run at once. The windows of one page run in order. The latency is stated | 3.5, 6.6 |
| Block annotations raise input tokens 1.5-2x | Heading paths, tab labels and table columns are printed once per change, not once per block | 3.5 |
| If offer.json is a derived view, a recall drop also degrades the old path | Shadow mode writes only record files. offer.json changes only in mode on. offer.legacy.json is kept 30 days | 3.9, 7.4 |
| Nothing re-enqueues a build dropped by a push | Builds are rows in D1 `record_builds`. Boot recovery re-enqueues them. Stages resume from the cache | 3.10 |
| Prompt complexity moved into the classifiers | The router does not change. The matcher gains entry kinds plus three inputs from its quantity vocabulary. "Attributes asked" is dropped | 4.3 |
| Code reading text was left unnamed (chat.ts:1157, :1168, :1229, :1601-1612) | Named and replaced | 3.11, 4.9 |
| clean() (offer/store.ts:107-144) drops unknown fields | Extended first, in P0 | 2.9 |
| Translation-only values and undated promotions were dropped | Translation-only values are used, marked, when the primary page lacks the attribute. An undated promotion is shown when named, as "no end date stated, on our site since <date>" | 3.7, 4.4 |
| The panel was described as views, not as a flow for a busy owner | Attention list, one-tap actions, typed edits, first-login check. Gaps are answered through each slot's own form. Inquiries show their matched items | 5 |

**Flaws in the other designs, avoided here:**
- consolidation by one LLM call (code does it here);
- quotes cut at 220 characters (never cut here);
- pages cut to 2 pages / 15k characters (packs stay at 40k);
- a reader as the only selector (packs and the card stay);
- name-keyed ids (ids are carried by code, URL and links);
- page 2 and later of listings never read (pagination pages are read);
- typed JSON-LD ranked above visible pages (the rutas.pl rule is kept).

### 0.3 How the owner's rules are kept

| Rule | How |
|---|---|
| The LLM writes every customer-facing word | The card, the lines and the computed amounts are structure written out for the model. The customer reads only what the writer writes. Panel read-backs of the owner's words are written by an LLM |
| text -> structure by an LLM or classifier | The LLM reads pages and splits off translations. Jev does page roles, claim checks and name pairs. The pinned matcher turns a message into entry ids and inputs |
| structure -> structure by code | Blocks, groups, joins, status, ranking, conflicts, absence, arithmetic, routing |
| Code never pattern-matches customer or page text | Blocks come from DOM structure. The reader resolves dates and labels into ISO values. Contacts are compared only as extracted values. "Contact given" is a Jev question. The regexes in 3.11 are deleted |
| General solutions only | Fixed attribute and term-slot lists for every business. The "other" slot is reviewed only to add general slots |
| Less prompt text | The AUTHORITATIVE paragraph and the 5,000-character contactText go. No new rule is added. Data lines have fixed budgets. Any added or removed prompt line must hold a blind pair |
| Every limit gets a docs/limits.md row | Appendix B. Each row is added in the commit that introduces the limit |
| Smoke-test one case before any batch | Every phase starts with one tenant or one case, read by hand (7.2) |
| Tests cost money | Every step's cost is stated. One full run, at the milestone (P5) |
| A push redeploys and drops re-scrapes | Push only with an empty scrape queue. Builds resume and are re-enqueued at boot. Flags live in render.yaml and are re-checked after each push |

---

## 1. The problem in numbers

### 1.1 How it was measured

- **The cases.** 63 conversations with the chats of 21 real businesses: rental, concrete, halls, photo/DJ, beauty and flowers, cakes, roofs, plumbing, parquet, and Whisp itself. They fall into 11 categories: price_multi 9, unknown_info 7, booking_order 7, out_of_scope 7, vague_need 7, terms_policy 7, prospect_probe 7, contact_hours_location 5, followup_multiturn 3, price_simple 2, scope_in_offer 2.
- **The ground truth.** Written from each live site and checked by an adversarial verifier: 273 "must" lines, 343 "must_not" lines and 318 source pages.
- **The run.** The cases are played on production with the probe header, so nothing is logged for the businesses.
- **The judges.** Three lenses (accuracy against the live site; customer experience, including speed; owner value) and blind pairs. Absolute scores move about +-0.15 between judging rounds, so the pairs are the comparison to trust.

| Iteration | Commit | Accuracy | Customer | Owner | First word median / p90 / max | Pairs vs previous (new-old-even) |
|---|---|---|---|---|---|---|
| 0 | 5f49aac | 3.10 | 2.98 | 3.00 | 3.3 / 6.6 / 19.5 s | - |
| 2 | eeb22cd | 3.25 | 3.13 | 3.21 | 2.9 / 5.2 / 7.6 s | 45-17-1 |
| 3 | 4151af8 | 3.14 | 3.22 | 3.27 | 2.9 / 5.1 / 9.5 s | 41-15-7 |
| 4 | 439c2fe | 3.33 | 3.32 | 3.22 | 3.0 / 4.5 / 9.4 s | 29-24-10 |

### 1.2 Where iteration 4 stands

**Scores:**
- 32, 30 and 33 of 63 pass the accuracy, customer and owner lenses respectively.
- 39 of 63 score 3 or less on some lens, and 20 of them score 2 or less.
- 4 score 1: djmw-2, romax-2, betonlazy-1, aniatkaczyk-1.
- 24 pass all three lenses. These are the regression set.
- Pairs against iteration 3 came out 29-24-10. Fixes inside the pipeline no longer move the result.

**Judge-free numbers:**
- **Source share.** Of each case's source pages, 0.49 reach the reply and 0.64 become candidates. So 36% of the pages that hold the answer are never even considered.
- **'partial'** was set on 54 of 134 turns (40%).
- **Blocked drafts.** 41 turns (31%) had a blocked draft, over 58 rounds: 20 unsupported, 20 meta-talk.
- **First token.** Median 3.0 s, p90 4.5 s. 12 turns took 4.5 s or more. The 4 background-agent turns took 85-244 s.

**Root causes** of the conversations scoring 3 or less on accuracy, from the judge synthesis: page selection 14, reasoning 6, routing 5.

### 1.3 The ranked problems (next-plan.md)

| # | Problem | Conversations hurt (at <= 2 / at 1) | Cause | This design |
|---|---|---|---|---|
| 1 | The page or fact that answers never shapes the reply | 17 (8) | selection | Partly. Facts are picked by id, each part's evidence page is reserved, each part gets its own search, partial scores are kept |
| 2 | Offer items have wrong or missing structure | 8 (5 / 1) | data | Yes |
| 3 | Own products sent to the background calculation or to competitors | 6 (4 / 2) | routing on loose passages | Yes, for parts the record resolves. Needs owner decision 1 |
| 4 | Knowledge base built from the wrong pages | 8 (5) | data (crawl) | Yes |
| 5 | Ended promotions and changed prices given as current | 4 (4 / 2) | data (dates) | Yes |
| 6 | Flagged claims go out; correct ones are blocked | 9 (4 / 1) | checks | Partly. The check reads the same lines as the writer and gets the `stale` question. "Never send a flagged draft" stays fix 6 |
| 7 | Site-wide terms and contact roles missing | 10 (5) | data | Yes |
| 8 | Orders contradict themselves; generic form | 6 (3) | state | Partly. The business's own form fields; `takesInquiries` as data for fix 8 |
| 9 | The quote stops short of what was asked | 5 (2 at 1) | quote structure | Yes. arith.ts, record structure, months counted as months |
| 10 | Owner demo probes fail | 5 of 7 probes | owner state | Partly. NIP/KRS on the card; "About this chat" built from the record |
| 11 | Slow first word on price turns | 12 turns | latency | Partly. Coverage is decided without the full/ours call |
| 12 | Network businesses described by what they only sell | 2 (1) | data | Yes |
| 13 | Language and form-of-address slips | about 10, low impact | writer | No |

### 1.4 What is wrong in the data

**Pages that hold the answer were never read, or lost to copies** (problem 4):
- **kwiaciarniamilosc.** 19 pages were read, 14 of them EN/UK copies. /regulamin/, /dostawa-i-platnosc/, /kwiaty-z-dostawa-warszawa/ and /florystyka-funeralna/ were never read, although they are in its sitemap or menu and return 200.
- **sweet_home.** The 150-page demo cap was used up on 17 muffin pages before any of its 6 wedding-cake pages.
- **dworekstaropolski.** 27 of 56 pages are /en/ copies. The old English page (140 zł) won over the Polish /nocleg-poznan/ (220 zł).
- **liliowa.** 41 of 59 pages are ?start=N gallery copies.
- **kamilkozielewicz.** 8 URLs exist twice, with and without "/" (old vectors).
- **zajacfoto.** Its 80-question FAQ is one page, which scored 0.11.

**Values read into the wrong structure** (problem 2):
- **sweethome-3.** "Tort czekoladowy" carries the neighbouring item's code (SH-3006) and no price.
- **sweethome-1.** Every wedding cake shows "- PLN": the K1/K2/K3 legend (140/160/180 zł/kg) is not resolved, and the minimum weights per design are ignored (SH-1102: K2, min. 7 kg).
- **Sweet Home, name-keyed merging.** Its wedding listing holds 3 "Biały tort weselny" (SH-1101 K1 9 kg, SH-1105 K2 6 kg, SH-6801 K3 4 kg) and 9+ "Tort weselny" with different codes. mergeItems keys them by name (offer/store.ts:154).
- **kwiaciarniamilosc-2.** The wreath shows 1090-2589 zł and three size names, but no price per size. The per-size prices exist only in the page's WooCommerce variation data (checked on the live page). The sash (+60 zł) and the delivery zones are not attached to the item.
- **angelikasolecka-3.** 200 zł/h with a 2 h minimum is quoted as "price on request".
- **dworekstaropolski-1.** "More than 85 adults on a Saturday, otherwise 2000 zł" is lost. The season tabs (Sezon 2027/2028/2026) come before three unlabelled tables, so only their order tells the seasons apart.
- **bostabeton-1.** "do 40 km" from the TransMix page is attached to other items.
- **romax-2.** Unpriced category pseudo-items are chosen over priced panels.
- **zajacfoto-3.** The foto+video package delivered with a partner is not recorded as its own.

**Out of date** (problem 5, all at 2 or less):
- **romax-2.** On 4.11 a promotion that ended on 31.10 was called current.
- **empro-1.** Expired promotions were offered instead of the current BLACK RED WEEKS.
- **aniatkaczyk-1.** Read on 2026-10-31; the page changed on 2026-11-03 to 3000/4200 zł.
- **kwiaciarniamilosc-1.** The Mother's Day 2026 page was used.

**No place to live** (problem 7):
- **dachywarszawa-3.** The NIP is only in the privacy policy, so the chat said "NIP nie jest podany".
- **empro-2.** Payment methods, dispatch time and free shipping from 500 zł are missing.
- **dachywarszawa-2.** The free estimate is missing.
- **whisp-1.** "Billed monthly, cancel any time" is missing.
- **bostabeton-1/-2/-3.** The office line is given instead of "Sprzedaż w Warszawie" (+48 22 50 80 990).
- **empro-3.** Numbers are regrouped ("+48 57 085 48 54").
- **romax-1, sweethome-1.** The wrong line is given for the salon or for weddings.
- **Knowledge audit on 12 pilots.** Payment terms were a gap on 12 of 12; 71% of all gaps were genuinely not on the site.

**Coverage decided from loose passages** (problems 3 and 12):
- **bostabeton-3.** Competitors were offered for smaller loads of its own HydroBeton ("ours" scored 0.79, against the 0.8 cut).
- **betonlazy-1** (owner score 1). After 186 s, Bosta Beton was asked to quote B20, which Łazy sells itself.
- **djmw-2** (owner score 1). After 125 s, Pełny Parkiet was priced inside DJMW's own quote.
- **zajacfoto-3.** Its own partner package went to the network.
- **angelikasolecka-2.** The florist floli.pl was presented as a beauty salon.
- **ostap-3.** Bosta Beton was listed for pumping.

### 1.5 Why today's structures cannot hold the answers

**The profile has five fields.** OfficialBusinessInfo (context/types.ts:46-62) holds:
- name, main phone, e-mail, address and hours;
- alternates;
- up to 5,000 characters of raw contact text (context/store.ts:216-223).

Payment, prepayment, delivery zones and fees, lead times, deposits, booking and contract rules, pickup requirements and NIP/KRS have no field. They reach a reply only if their page wins page scoring.

**Offer extraction reads cut pages:**
- It reads 6,000-character windows (offer/extract.ts:46) of pages cut at 24,000 characters (offer/index-scrape.ts:18-20).
- Header, footer, navigation and forms are removed first (:126), and blocks repeated on 40% of pages are dropped (:134-136).
- So the footer NIP, labelled phones, select options (sizes, add-ons) and the tails of long pages never reach it, and tab labels are lost.

**Merging by name, min/max only:**
- mergeItems keys non-shop items by lower-cased name (offer/store.ts:154).
- Store APIs keep only the minimum and maximum price (scraper/catalogue.ts:38, :81-94).

**No dates.** No item, chunk or profile value has a validity, so nothing can ever be "ended".

**Coverage comes from loose passages:**
- Jev full/ours over up to 40k characters of passages (llm/chat.ts:1005-1015; "ours" >= 0.8 at :1045);
- simple/allOurs (:819-836), hasPricesFor (:1395), offeredForForm (:1480);
- a `/\d/` test on the customer's text (:784).

**Page selection is the only route to a fact:**
- One vector search runs over the whole message, plus one over the joined parts.
- Jev scores whole pages against the whole message, and the top 4 at >= 0.5 within 40k characters are used (chat.ts:931-938, packs.ts:110-177).
- One failed scoring batch nulls every score (packs.ts:135).
- The previous turn's pages stay only on follow-ups (chat.ts:933).

**Every re-scrape starts from zero:**
- Page hashes are computed (context/store.ts:143) but not saved (multi-tenant/scrape-pipeline.ts:265-270).
- Every chunk is labelled again (context/store.ts:507-555), and every offer page is read again.
- The quote program fingerprints raw page text (pricing/model.ts:325).

---

## 2. The representation

### 2.1 Where it lives

**R2.** Always read from R2, never from local disk first, which avoids the context-meta.json gotcha.

| Key | Contents |
|---|---|
| `tenants/<id>/record/current.json` | `{ buildId, builtAt }`. The pointer, written last; this makes the switch atomic |
| `tenants/<id>/record/<buildId>.json` | The record: pages, groups, entities, claims, capabilities, conflicts, absent, completeness, build stats. No page text: claims point at blocks. The current build and 2 previous ones are kept |
| `tenants/<id>/record/blocks/<pageId>.json` | The blocks of each page read: the evidence store. Written page by page during the crawl |
| `tenants/<id>/record/changes.json` | Per build: effective values added, changed, ended or removed. Kept 365 days; this is the panel's change feed |
| `record-cache/read/<key>.json`, `record-cache/verify/<key>.json` | Reader and verifier outputs, keyed by content (3.10) and shared by all builds and tenants |

**D1.** Tables are created lazily with `d1Query("CREATE TABLE IF NOT EXISTS ...")`, as in security/quota.ts:21:
- `record_builds (tenant_id, build_id, reason, mode, stage, state, pages_total, pages_done, cost_usd, jev_tokens, error, created_at, updated_at)` - the durable build queue;
- `record_edits (tenant_id, id, target, action, value_json, words, by, at, undone_at)` - the owner layer;
- `record_demand (tenant_id, key, day, asked, unanswered)` - what real customers asked, per entity or slot;
- `record_lease (name, holder, until)` - keeps one build runner and one freshness job across Render instances.

**Registry.** Per tenant: `settings.record = "off" | "shadow" | "on"`, default off.

### 2.2 Sources (code)

```ts
// src/record/schema.ts (new)
export const RECORD_SCHEMA = 1;

export type PageRole = "home" | "offer_listing" | "item_detail" | "price_list" | "terms" | "delivery_payment"
  | "contact" | "about" | "faq" | "article" | "promotion" | "gallery" | "legal" | "other";

export interface RecordPage {
  id: string;            // sha1(URL with scheme, www, trailing slash and fragment folded)
  url: string; title: string;
  lang: string;          // <html lang> / hreflang; the pairing call (3.4) only when both are missing
  role: PageRole;        // Jev choice over the page card
  group: string;
  member: "primary" | "pagination" | "translation" | "older_version" | "alias" | "copy";
  found: ("sitemap" | "menu" | "footer" | "link")[];
  period?: Validity;     // the page's own period (a dated price list, a promotion page)
  fetchedAt: string; lastmod?: string; etag?: string; lastModified?: string; postDate?: string;
  blocksHash: string;    // hash of its block hashes
  read: "read" | "copy" | "cap" | "failed";
}

export interface Block {
  id: string;            // <pageId>:<hash(DOM path + text)>, stable while the block is unchanged
  kind: "heading" | "paragraph" | "list_item" | "table_row" | "dt" | "dd" | "form_label" | "form_option"
    | "image_alt" | "pdf_row" | "typed";
  text: string;          // inline elements stay in their sentence (the "nie wliczony" lesson)
  headings: string[];    // heading path above it
  tab?: string;          // label of the control that owns its panel: aria-labelledby, aria-controls, href="#id", <summary>
  table?: { caption?: string; columns: string[] };
  region: "main" | "aside" | "header" | "footer" | "nav";
  hidden?: true;         // hidden, aria-hidden, <template>, inline display:none
  links?: string[];
  typed?: string;        // jsonld:<path> | microdata | woo_variation | shopify_variant | store_api:<field> | tel | mailto | maps:<field>
}
// Header, footer and aside blocks repeated on >= 40% of pages are stored once, on the pseudo-page "site" (role chrome).

export interface PageGroup { id: string; kind: "translation" | "pagination" | "alias" | "version" | "copy"; primary: string; members: string[] }
```

### 2.3 Entities

The LLM proposes entities, Jev checks the name, and code joins duplicates across pages.

```ts
export type EntityType = "business" | "location" | "contact" | "person" | "category" | "item" | "variant"
  | "addon" | "package" | "promotion" | "legend" | "faq" | "partner" | "term";
export interface Entity {
  id: string;            // carried over from the previous record (3.7)
  type: EntityType;
  name: string;          // as the site writes it
  parent?: string;       // variant/addon -> item; item/package -> category; contact/location -> business
  code?: string;         // the site's own identifier (SH-1102, K2, SKU), compared only as an extracted value
  url?: string;          // its own page
  pages: string[];
}
```

### 2.4 Claims: every value has evidence, condition and validity

```ts
export interface Claim {
  id: string; entity: string; attr: string;         // attr from 2.5 or a slot from 2.6
  value: Value;
  condition?: Condition; ruleGroup?: string;        // "otherwise" ties a branch to its siblings
  validity: Validity;
  evidence: { page: string; blocks: string[] }[];   // typed claims cite their typed block
  origin: "page" | "typed" | "file" | "interview" | "owner" | "maps" | "derived";
  check: { by: "jev" | "llm" | "typed" | "owner" | "code"; score?: number; repaired?: true; result: "kept" | "rejected" };
  seen: { first: string; last: string };            // crawl dates
  status: Status;                                   // code, on load and per turn
  rank?: number;                                    // code (3.7)
  translationOnly?: true;
}
export type Status = "current" | "future" | "ended" | "superseded" | "alternative" | "conflict" | "undated" | "withdrawn";
export interface Validity {
  from?: string; to?: string; label?: string;       // ISO dates, resolved by the reader; label as written ("Sezon 2027")
  basis: "stated" | "tab_label" | "heading" | "page_period" | "post_date" | "none";
  inferredYear?: true;                              // a date written without a year took the read date's year
}
export type Value =
  | { money: { amount: number; max?: number; currency: string; per?: string; from?: true; gross?: boolean | null } }
  | { number: { n: number; unit?: string } } | { range: { min: number; max: number | null; unit?: string } }
  | { bool: boolean } | { enum: string } | { enums: string[] }
  | { hours: ({ days: string[]; open: string; close: string } | { days: string[]; closed: true } | { label: string; open?: string; close?: string; closed?: true })[] }
  | { date: string } | { ref: string }
  | { label: string };                              // a literal as displayed (a phone, an area list, a spec), never paraphrased
export interface Condition {                        // inputs use one vocabulary with offer/quantities.ts INPUT_HELP
  qty?: { input: string; min?: number; max?: number };   // guests, adults, children, hours, days, kg, m2, m3, km, pieces, people, services
  days?: string[]; dates?: { from?: string; to?: string; label?: string };
  zone?: { id: string; minKm?: number; maxKm?: number; areas: string[] };
  location?: string; channel?: "online" | "in_store" | "phone"; customer?: "private" | "business";
  with?: string[]; otherwise?: true;
}
```

Code computes each status against today (Europe/Warsaw) and, at reply time, against the customer's date:

| Status | When |
|---|---|
| ended | `to` has passed |
| future | `from` is ahead |
| superseded | The value lost the ranking (3.7): it comes from an older version, or from a translation while the primary states the attribute |
| alternative | Same page member, lower role rank |
| conflict | Same rank, different value |
| undated | A promotion with no stated period. Never current; shown only when named, with its first-seen or post date |
| withdrawn | The owner hid it, or its page left the site |

### 2.5 Attributes (fixed, general)

| Entity type | Attributes |
|---|---|
| item, package, variant, addon | price; price_category (ref -> legend); unit_of_sale; min_qty; min_value; capacity {input, n, counted_from?} (5 services, 6 h "from the given hour", 10 h "from the couple's entrance"); extension_price; includes[]; excludes[]; requires[] (what the customer provides); lead_time; availability; fulfilment; spec (label pairs); kind (offer/schema.ts FIELDS.kind); sku; pack (amount per package, e.g. 1.824 m²); audience (private, business); applies_to (addon -> items or categories) |
| promotion | benefit; threshold; applies_to; eligibility. Its period is its validity |
| location | address {street, building, unit, postal, city, display}; kind (shop, showroom, office, plant, warehouse, studio, venue, pickup_point, branch); hours; exceptions (special days as the site names them); contacts; offers_here (category refs); access |
| contact | channel (phone, email, form, whatsapp, messenger, booking_link); display (as shown, never regrouped); key (digits or lower case, made by code from the extracted value); role (general, sales, office, orders, bookings, events, rooms, service, support, department, person, branch); role_label (the site's label); scope (location, category or person refs); hours |
| business | brand_name; legal_name; legal_form; nip; regon; krs; bdo; registered_address; area_served |
| faq | question (label). The answer is its evidence blocks, word for word |
| partner | name; domain; relation (partner_delivered, recommended, subcontractor, supplier); what |
| legend | code -> value (K2 -> 160 PLN per kg) |

### 2.6 Term slots (entity type `term`)

The list is fixed. Each value is scoped to one of: business, location, category, item, channel, customer type.

| Family | Slots |
|---|---|
| payment | payment.methods (cash, card, blik, transfer, online_gateway, cod, invoice_terms, installments, leasing); payment.prepayment {required, share full or part, amount or percent, when}; payment.when |
| deposit | deposit {type zadatek, zaliczka or kaucja; amount or percent; refundable; purpose; remainder_due} |
| price basis | pricing.gross_net; invoice.vat |
| delivery | delivery.available; delivery.area; delivery.zones [{zone, fee, free_from, lead_time, cutoff}]; delivery.window; dispatch.time |
| pickup | pickup.available; pickup.place; pickup.requirements; pickup.deposit |
| timing | order.notice; order.cutoff; lead_time |
| booking | booking.how; booking.max_ahead; booking.confirmed_by; contract |
| after-sale | cancellation; reschedule; returns; warranty |
| minimums | minimum.order |
| rental | rental.period_rule; order.requirements (documents) |
| area | travel.free_radius; travel.from; travel.fee_per_km; service.area |
| estimate | estimate.free; estimate.how |
| subscription | subscription.period; subscription.cancel |
| other | other {label}. Reviewed to add general slots, never per business |

**Standard topics per trade.** A code table in src/record/schema.ts, keyed by BusinessType like APPLIES at offer/schema.ts:158. It decides which slots are recorded as absent when the site does not state them:

| Trade | Standard slots |
|---|---|
| every business | brand_name, nip, a general contact, an address, hours, payment.methods |
| shop | dispatch.time, delivery.zones or area, free_from, returns, warranty, pricing.gross_net |
| rental | order.requirements, deposit, rental.period_rule, delivery or pickup, pricing.gross_net |
| contractor | estimate.free, service.area or travel, warranty, deposit, lead_time |
| appointment | booking.how, deposit, cancellation, travel, lead_time |
| food | order.notice, delivery.zones, payment.prepayment, minimum.order, pickup |

Slots that this tenant's customers asked about (record_demand) are added for that tenant.

### 2.7 Coverage

```ts
export interface Capability {
  entity: string;    // item, category or service
  kind: "own" | "partner_delivered" | "recommended" | "resold" | "not_offered" | "mentioned_only";
  partner?: string;  // partner entity
  evidence: { page: string; blocks: string[] }[];
}
```

A capability is `not_offered` only when a sentence of the site (or the owner) says so, for example "nie zajmuję się animacjami". Missing information is never `not_offered`.

### 2.8 Conflicts, absence, completeness, build

```ts
export interface Conflict { entity: string; attr: string; claims: string[]; class: "superseded" | "alternative" | "unresolved" | "owner"; preferred?: string }
export interface Absent { slot: string; scope?: string; reason: "not_stated" | "not_read"; unread?: number; standard: boolean }
export interface BusinessRecord {
  schema: 1; tenantId: string; buildId: string; builtAt: string;
  pages: RecordPage[]; groups: PageGroup[]; entities: Entity[]; claims: Claim[];
  capabilities: Capability[]; conflicts: Conflict[]; absent: Absent[];
  complete: { offer: boolean; terms: boolean; unread: string[] };
  build: { readOn: string; models: { reader: string; verifier: string };
           crawl: { declared: number; read: number; capHit: boolean; unread: string[] };
           counts: { pages: number; blocks: number; entities: number; proposed: number; kept: number; rejected: number; repaired: number; conflicts: number; absent: number };
           costUsd: number; jevTokens: number; previous?: string };
}
```

**Absence reasons:**
- `not_stated`: every declared page (sitemap, menu, footer) was read, and so was every page of the roles that would state the slot.
- `not_read`: otherwise. It carries the number of declared pages left unread.

**Completeness.** `complete.offer` is true when every declared page and every offer page (offer_listing, item_detail, price_list) was read, or when a store-API import finished. Only then can a part of a question be "not in our offer".

### 2.9 Ids, stability, compatibility

**Ids:**
- Block ids stay the same while the block is unchanged.
- Entity ids carry over from the previous record when the entity has the same code, the same own URL, or (name only) Jev >= 0.7 for the same type in the same category.
- Owner edits attach to entity ids. An edit whose entity disappears goes to "needs review" in the panel; it is never silently dropped.

**OfferItem changes** (offer/store.ts):
- OfferItem (:15-29) gains optional fields: rid (the entity id), variants, addons, minimum, capacity, extension, includes, excludes, conditions, validity, coverage, evidence.
- clean() (:107-144) must carry these fields **first**. Today it rebuilds a fixed shape, so every save would erase them.
- mergeItems (:151-173) keys by rid when present.
- renderItem (:195-211) prints the new fields.

Old items load unchanged.

### 2.10 Example (claims as built for three eval tenants)

**dworekstaropolski.com:**
- **Ceremony price, two branches.**
  - Entity "Wynajem Sali Świerkowej na ślub": price 100 PLN, with condition {qty adults min 86, days [sat]}, ruleGroup g1.
  - The same entity: price 2000 PLN, condition {otherwise g1}.
  - Both have validity {label "Sezon 2027", 2027-01-01..2027-12-31, basis tab_label} and cite the price list's blocks.
- **Ceremony alternatives.** "from 500 zł" (/slub-i-wesele/, offer_listing) and "500-2000 zł" (Ślub w dworku) are class alternative.
- **Banquet Hall.** 285 PLN per person, condition {qty guests 50-69, days [sat]}, Sezon 2027, decoration included. Sala Świerkowa: spec "do 50 Gości".
- **Rooms.**
  - "Pokój 2-osobowy" 220 PLN per night (/nocleg-poznan/, primary). 140 PLN (/en/accomodation/, translation) is superseded.
  - Breakfast 35 PLN per person; breakfast hours per day (Sunday 8:30-10:00).
- **Old list.** "Wedding Menu 2016" (/en/wedding-menu-and-price-list/): page period 2016, ended.
- **Absent.** Pets: not_stated, scope rooms.
- **Contacts.** "+48 504 107 024" (role events, role_label "Wesela, imprezy") and "+48 61 887 66 60" (role rooms, role_label "Rezerwacje pokoi").

**kwiaciarniamilosc.pl:**
- **Wreath variants.** "Biały Wieniec Pogrzebowy" has three variants, typed from the page's variation data: Średni 1090, Duży 1690, Królewski 2589 PLN.
- **Add-on.** "szarfa z napisem" +60 PLN, applies to every composition (category ref).
- **Delivery.** term delivery.zones has two zones: z1 {maxKm 10, areas Mokotów, Śródmieście, Ochota, Wola, Wilanów} fee 30 PLN; z2 {10-20 km} fee 58 PLN. term order.cutoff is 17:00 for same-day delivery.
- **Payment.** term payment.prepayment is {required, share full}, scope channel online. term payment.methods is [blik, card] for online and [cash] for in_store.
- **Conflict.** /balony-i-dodatki/ says "BLIK, karta lub przelew online"; the regulamin excludes the transfer. Both are primary pages of equal role rank, so the class is unresolved.
- **Identity.** nip 5214154370 and krs 0001225239, from the regulamin.

**sweet-home.pl:**
- **Items.** SH-1101, SH-1105, SH-6801 and SH-1102 are four entities, told apart by their codes and own URLs.
- **Prices.** SH-1102 has price_category ref K2 and min_qty {kg 7}.
- **Legend.** The legend K2 -> 160 PLN per kg is read from the legend page if there is one. Otherwise code derives it from >= 2 items that state "160 zł / kategoria cenowa: K2" and none that disagree (origin derived).

### 2.11 Why each field exists (failing case -> fact -> field)

| Case | Fact the right reply needs | Field |
|---|---|---|
| romax-1 | Fort Wola sells tiles; closed on Sundays; Saturday 9-15 | location.offers_here, hours, exceptions |
| kwiaciarniamilosc-1/-2 | Full online prepayment; same day if ordered by 17:00; sizes 1090/1690/2589; sash +60; Wola zone 30 zł | payment.prepayment (channel), order.cutoff, variants, addon.applies_to, delivery.zones |
| sweethome-1/-3 | K1/K2/K3 per kg; minimum kg per design; the item's own code | legend, price_category, min_qty, code |
| aniatkaczyk-1 | Komfort 3000 zł = 5 services, +500 zł per extra; Premium 4200 zł = 7; travel free to 30 km | capacity, extension_price, travel.free_radius |
| zajacfoto-1/-3 | 6 h + 500 PLN per hour; Standard until 1:00; foto+video with a partner | capacity, extension_price, Capability partner_delivered |
| sosnowydwor-2 | "W cenę nie wliczony jest alkohol i muzyka" | excludes, Capability not_offered |
| dworekstaropolski-1/-3 | Sezon 2027; 100 zł only above 85 adults; EN copy superseded; pets not stated | validity (tab_label), condition + ruleGroup, member rank, Absent |
| romax-2, empro-1 | Royale ended 31.10; BLACK RED WEEKS current; free shipping from 500 zł | promotion validity, delivery.zones.free_from |
| bostabeton-1/-3 | NIP/KRS; the "Sprzedaż w Warszawie" line; HydroBeton minimum 4 m³ | business.nip/krs, contact.role_label, min_qty |
| dachywarszawa-2/-3 | Free estimate; NIP from the privacy policy; e-mail from mailto | estimate.free, business.nip, typed contact |
| whisp-1 | 149 zł per month, monthly, cancel any time | price per month, subscription.period/cancel |
| rentbud-3 | Tower 120 zł/doba; Saturday 7:30-13:00; documents and deposit | item price, location hours, order.requirements, deposit |

---

## 3. The build pipeline

### 3.1 Overview

| Stage | Who | What | Where |
|---|---|---|---|
| S0 Crawl | code | Listed pages first; children of each listing in turn; a completeness pass; hreflang, rel=next, lastmod and ETag kept | scraper/crawler.ts crawlSite, enqueue, fetchSitemapUrls; extractor.ts extractMetadata, extractLinks |
| S1 Segment | code | DOM blocks with heading path, tab label, table columns, region, links; typed blocks; site chrome stored once | record/blocks.ts segmentHtml, typedBlocks, siteChrome |
| S2 Groups, roles | code + Jev + one LLM call | Copies, translations, pagination, aliases, older versions; a role per page | record/groups.ts pageGroups, pageRoles, pairTranslations |
| S3 Read | LLM (Haiku 5.5) | Entities and claims, each citing block ids | record/read.ts readPage |
| S4 Verify | Jev (build key) | Each claim against only its cited blocks; one repair round | record/verify.ts verifyClaims, repairClaims |
| S5 Resolve | code + Jev for name-only pairs | Join entities by code, URL and links; carry ids over | record/resolve.ts resolveEntities |
| S6 Reconcile | code | Status, ranking, conflicts, legends, absence, completeness | record/reconcile.ts |
| S7 Views | code | offer.json, officialInfo, offer-pages.json, pricing input, capabilities, inquiry form | record/views.ts |
| S8 Publish | code | Atomic write, history, change feed, cache eviction | record/store.ts saveRecord |

Each stage writes its output to R2. An unchanged page is never read or verified twice (3.10).

### 3.2 S0 Crawl [code]

**What stays:**
- politeness and throttling;
- the browser retry for bot checks;
- canonical aliases (crawler.ts:226-238);
- content-hash duplicates (:240-242);
- the trap guard;
- triage.ts for large sites;
- the store-API catalogue for big shops.

**New page data:**
- extractMetadata (extractor.ts:48-65) also returns hreflang alternates, rel=next/prev, og:locale and the article:published_time value.
- extractLinks gives each link its region (nav, header, footer, aside, main). PageLink (scraper/types.ts:39) gains `region`.
- fetchSitemapUrls (crawler.ts:328-352, which reads only <loc> at :341) keeps <lastmod>.
- ETag and Last-Modified are kept from the response headers.

**Queue order** replaces KEY_PAGE_PATTERN (crawler.ts:34, a URL-word regex):
1. Pages declared by the sitemap, the menu or the footer.
2. Children of listing pages, taken in turn per parent. Every listing gets its first N children before any listing gets N+1. This fixes Sweet Home's cap, which went to muffins.
3. Everything else. Links under another language's hreflang root go last.

**Completeness pass.** After the crawl, declared pages that are still unread are fetched, up to 30 beyond the cap. Kwiaciarnia's regulamin and delivery page would come in here.

**S1 runs inside onPage,** and blocks go to R2 page by page. Memory stays flat, which is the lesson of the 2026-09-28 out-of-memory crash.

S0 applies only to tenants in mode shadow or on.

### 3.3 S1 Segment [code]

`segmentHtml(html, url)` walks the whole body in reading order, using the textBlocks logic (index-scrape.ts:86-108). Inline text stays in its sentence. Nothing is removed; header, footer, aside and forms are tagged with their region instead.

Each block gets:
- its heading path (a stack of h1-h6, caption, legend);
- its tab or accordion label: the text of the control that owns the block's panel, found through `aria-labelledby`, `aria-controls`, `href="#id"` or `<summary>`. These are DOM attributes, not text, and they label Dworek's three season tables;
- for a table row, the header cells;
- its links;
- a hidden flag: the `hidden` attribute, `aria-hidden`, `<template>`, or inline `display:none`.

**Forms.** Form labels and select options are blocks too, for example Sweet Home's "Krem na mascarpone (+15zł/kg)" and Woo size selects.

**Typed blocks** are mapped by code, with no model:
- JSON-LD (the logic of fromJsonLd, index-scrape.ts:53-79, and business-profile.ts:127-143) and microdata;
- WooCommerce `data-product_variations`: one block per variation, with attributes, display_price, sku and stock. This is where kwiaciarnia's per-size prices live;
- Shopify product JSON;
- tel: and mailto: hrefs;
- store-API fields (catalogue.ts). Every variant and its price is kept. Today only min/max survive (:38, :81-94). Woo variable products' variation prices are read from the Store API by variation id; this endpoint needs checking on empro in P0.
- Google Maps fields (origin maps, lowest rank).

**PDFs.** One block per laid-out row from pdf-text.ts, instead of pdf.ts's 1,500-character splits at ". " (:20-33).

**Site chrome.** Blocks in header, footer, nav or aside whose hash repeats on >= 40% of pages are stored once on the "site" pseudo-page. Today index-scrape.ts:134-136 drops them, along with the footer NIP and labelled phones. This is hash equality, not text matching.

### 3.4 S2 Groups and page roles [code + Jev + one LLM call]

**Groups, found by code:**
- alias: canonical, plus scheme, www and trailing-slash forms;
- translation: hreflang clusters;
- pagination: rel=next/prev chains;
- copy: the same path with another query string, or >= 90% shared block hashes outside chrome (liliowa's ?start=N galleries).

Same path, different query and fewer shared blocks means a distinct page, and it is read. No URL word decides a group.

**Primary page of a group:** the member in the site's primary language (hreflang x-default, else the language of most pages); for pagination, the first page.

**Page roles.** One Jev choice per page over its card (title, URL, H1/H2s, the first 400 characters of main blocks), in batches of 25, as offerPages does today. Roles replace:
- the Jev offer-page yes/no (index-scrape.ts:158-169);
- the contact-URL regex (context/store.ts:117);
- ARTICLE_URL (packs.ts:22) and facts.ts ARTICLE.

**Translation pairing.** One LLM call (Haiku 5.5) per 100 page cards. It pairs translations that declare no hreflang (Dworek's /en/, /de/, /ru/) and marks older versions of the same page (cennik-2025 vs cennik-2026). It returns page ids only.

**What gets read:**
- primaries and pagination: always;
- translations and older versions: last, budget allowing (for conflicts and the panel). Their values are never current over a primary value;
- copies: never.

### 3.5 S3 Read [LLM]

**Model.** Haiku 5.5, temperature 0, pinned provider, reasoning off, key OPENROUTER_BUILD_KEY. deepseek-v4.1-flash is measured against it in P2 before the choice is final.

**Input:** the page title, URL, role, the date read, and its blocks with short local ids. The heading path, tab label and table columns are printed once each time they change, not on every block. This keeps the annotation overhead near 1.15x:

```
## Menu i cenniki > [tab: Sezon 2027]
table: Sala | Dzień | Liczba osób | Cena
[b12] Sala Bankietowa | sobota | 50-69 osób | 285 zł
[b13] Sala Bankietowa | sobota | 70-89 osób | 260 zł
```

**Windows.**
- Whole blocks only, up to 8,000 characters per window, with a 2-block overlap. The page is read whole, with no 24,000-character cut.
- The windows of one page run in order. Each window gets the entities found so far, as ids to reuse, so pairing is by id and not by name.
- Up to 16 pages run at once.

**Output (JSON).** Periods and scopes are declared once and referenced by id:

```json
{"entities":[{"k":"e1","type":"item","name":"Sala Bankietowa","parent":"e0","blocks":["b10"]}],
 "periods":[{"k":"p1","label":"Sezon 2027","from":"2027-01-01","to":"2027-12-31","basis":"tab_label"}],
 "claims":[{"e":"e1","attr":"price","value":{"money":{"amount":285,"currency":"PLN","per":"osoba"}},
            "cond":{"qty":{"input":"guests","min":50,"max":69},"days":["sat"]},"period":"p1","blocks":["b12"]}],
 "terms":[], "coverage":[{"e":"e1","kind":"own","blocks":["b10"]}], "faq":[], "page_period":null}
```

**The prompt** is the schema (with its enums) plus five rules:
1. Cite the blocks for every value.
2. Copy names, labels, codes and displayed contacts exactly as written.
3. Give numbers only as written; no arithmetic.
4. Give a condition or a period only when the blocks, their headings, tab labels or the page title state it.
5. Leave out what is not stated.

For pages, this replaces extractFromBlock (extract.ts:42-71). Legal pages (regulamin, privacy, cookies) and the "site" chrome page are read like any other page; they hold NIPs and payment rules.

### 3.6 S4 Verify [Jev, build key]

**The question.** One noul question per claim. The state holds only the claim's cited blocks (with heading path and tab label) and the block that names its entity. The question refers to them by key:

> Do `b12` (a block of the website of `business`) state, about this business itself - not a partner, a client, an example or a blog's general advice - that for `Sala Bankietowa` the price is 285 PLN per person, for 50-69 guests on a Saturday, valid in Sezon 2027? The same amounts however written count; answer no if it belongs to another item, is a general statement or is only implied.

**Coverage** gets one choice question over the six kinds.

**Batching and threshold.** Questions are batched per page, at most 40 per call. A score below 0.5 rejects the claim; 0.5 is the confirmItems threshold from bf84086.

**Repair round.** Every rejected claim, of any family, gets one round: the reader sees the claim, its blocks and the window, and returns corrected block ids and value, or drops it. The claim is then verified again. If it is still rejected, it is stored as rejected: listed in the panel, never served.

**Typed claims** need no check. This stage merges confirmItems (extract.ts:78-98) and verifyFields (index-scrape.ts:177-189).

**If Jev is down,** the stage waits and the previous record stays live. A version is published only after its verification has finished. After 24 hours of build-key outage, a pinned deepseek yes/no per claim id takes over. That model is different from the reader. Such claims are marked `check.by: "llm"` and verified again by Jev when it is back.

### 3.7 S5 Resolve and S6 Reconcile [code, Jev only for name-only pairs]

**Resolve.** Code joins entities that share any of:
- the same code or SKU;
- the same own URL;
- a listing block that links to the page whose main entity it is.

Pairs of the same type that share nothing but a similar name are candidates when their bge-m3 similarity is >= 0.85 within one category. Jev then asks "the same product or service of this business, just named differently?" and accepts at >= 0.7, today's dedupe threshold.

Entities with different codes or different own URLs are never merged; this is the shop rule of offer/store.ts:154. Ids carry over from the previous record the same way (2.9). This replaces dedupe (index-scrape.ts:197-219) and name-keyed merging.

**Ranking,** per entity and attribute, in this order:
1. **Owner claims.** They win until the owner changes them. If the site later changes a confirmed value, `siteChanged` is set.
2. **Status.** Ended and superseded values are never current. A future period applies only to a customer date inside it. Undated promotions are never current.
3. **Page member.** Primary and pagination > translation > older version. A value found only on a translation, whose primary group lacks the attribute and is not an older version, is used, marked `translationOnly`.
4. **Page role,** by attribute family:
   - prices: price_list > item_detail > offer_listing > home > faq > terms > article;
   - terms: terms = delivery_payment > faq > item_detail > home > article;
   - contacts and hours: contact > chrome > home > other > JSON-LD > Google Maps;
   - legal identity: legal = terms = contact = chrome.
5. **Region,** for item attributes: main > aside > chrome.
6. **Typed against visible.** JSON-LD that disagrees with the visible primary value loses. This is the rutas.pl rule (profile-verify.ts:4-7); its shownOnPage call is no longer needed.
7. **Recency:** lastmod, then postDate, then first seen.

**Conflicts.** Equal values (numbers within 0.5%, equal enums) merge their evidence. Different values whose conditions can both hold become conflicts:
- superseded: lower member rank, or ended;
- alternative: same member, lower role rank;
- unresolved: same rank. Both values are passed on, and the owner is asked;
- owner: an owner claim wins.

**Legends.** A legend is read from a legend page. Otherwise code derives one from >= 2 items with the same price_category code and equal per-unit price claims, with no item disagreeing (origin derived; evidence = the union). It then applies the legend to items of that code that state no price.

**Absence and completeness** follow 2.6 and 2.8.

### 3.8 S7 Views [code]

| View | From the record | Read by |
|---|---|---|
| offer.json (mode on only) | Current items as OfferItem plus the optional fields. Ended and superseded items are left out. Written with saveOffer + mergeItems, keyed by rid, so owner_set survives | chat, network offerMatches, compare, order forms, network index |
| offer.legacy.json | The last output of today's extractor, kept 30 days after the switch | rollback |
| context-meta officialInfo | Card fields mapped to OfficialBusinessInfo | site card, audits, tenants that do not know the record |
| offer-pages.json | Block text of the current primary price pages | the quote program until RECORD_PRICING |
| Pricing input (RECORD_PRICING) | Current price claims + their evidence blocks + term slots, with record ids as catalogue ids. The hash is computed over price and term claims, not raw text (model.ts:325). Term-slot pages replace the Jev rules-page guess (:328) | pricing/model.ts buildBusiness |
| Capability records | Own and partner_delivered capabilities only. The region comes from a location's structured postal field | network/capability-index.ts |
| Inquiry form | Fields from order.requirements, booking and pickup slots plus the business types, derived once with deriveFields (flows/collect.ts:64) | flows/collect-store.ts, replacing DEFAULT_INQUIRY (:20-23) |

### 3.9 S8 Publish and the per-tenant modes [code]

**Publish order:** write the blocks and caches, then `record/<buildId>.json`, then `current.json`. Keep 2 history versions, append to changes.json, and evict the cached chat with `tenantManager.evictTenant`. Other Render instances read `current.json` at most every 5 minutes.

**What publish triggers:**
- the network index rebuild (reindexNetwork, serve-multi-tenant.ts:2052);
- the knowledge audit's data checks, which read the record's absent slots, conflicts and unread pages instead of the profile and the text regexes (knowledge/audit.ts:38-55).

| Mode | Builds | Serves | offer.json / officialInfo |
|---|---|---|---|
| off | no | today's path | today's extractor |
| shadow | after every re-scrape | today's path (the `record` variant serves it for eval requests) | today's extractor; the record writes only record files |
| on | after every re-scrape | the record path (section 4) | the record's views; today's offer indexer is skipped |

### 3.10 Running builds: queue, cache, keys, budget, outages, pushes

**Queue.**
- After a successful scrape, `worker.onScraped` (serve-multi-tenant.ts:2058) inserts a `record_builds` row.
- An owner upload, an interview, the admin route POST /api/admin/record/:id, or the nightly freshness job can also add one.
- Builds share the scrape worker's slots (SCRAPE_JOBS) and run only when no scrape is waiting.
- One runner holds the `record_lease` row.

**Boot recovery.** At boot, rows in state queued or running are re-enqueued, giving up after 3 interrupts like scrapes do. Today's recovery only re-enqueues pending or scraping tenants (background-worker.ts:157-167), so a live tenant's dropped job is lost.

**Content-addressed cache.**
- The read key is sha1(schema version + reader model + prompt version + page title + rendered blocks).
- The verify key is sha1(claim + cited blocks text + Jev model).
- Both are shared across builds and tenants. A build dropped by a push redoes only the windows in flight. A prompt or schema change rebuilds from stored blocks without crawling. Readings made offline in P2 are cache hits in production.

**Chunk labels.** enrichChunks (context/store.ts:507-555) reuses a chunk's label when the same chunk id existed in the previous knowledge catalog. Chunk ids hash the raw body, heading path and position, so unchanged chunks are not labelled again. The label is our own stored output, parsed by its own format.

**Keys and budget.**
- JEV_BUILD_API_KEY and OPENROUTER_BUILD_KEY are separate, so a build can never drain production into safe mode.
- RECORD_BUILD_DAY_USD (default 15) is tracked in spend_daily under the key `record-build`. Builds pause when it is reached.
- Check the Jev balance before every batch.

**Pushes.** Push only with the scrape queue empty. The flags live in render.yaml, and env vars are re-checked after the push (the blueprint sync resets them).

### 3.11 Keep, replace, merge

**Keep:**
- crawler.ts (politeness, aliases, duplicate hashes, browser retry, trap guard) and triage.ts;
- catalogue.ts, extended to keep variants;
- fromJsonLd and textBlocks, as the base of segmentation;
- pdf-text.ts rows;
- the FIELDS enums;
- OfferItem and offer.json, as a derived view with owner_set;
- matchItems' pinned call, shortlist and memo;
- quantities.ts and recipe.ts;
- the QuickJS quote program and its verification loop (only its input changes);
- the router, packs, the checks, the network search, the project agent.

**Replace** (for record tenants first, deleted in P10):

| Today | Replaced by |
|---|---|
| extract.ts:46 6,000-character windows; index-scrape.ts char windows (:227-234), 24k cut (:20), chrome removal (:126), repeated-block drop (:134-136), offerPages (:158-169), verifyFields (:177-189), dedupe (:197-219) | S1-S5 |
| business-profile.ts extractProsePhone (:92-115, a regex on prose); renderOfficialInfo and its AUTHORITATIVE paragraph (:261-281) | contacts from blocks; the card |
| profile-verify.ts candidate regexes (:43-80) and the label regex over contactText (:151-173) | contacts with roles and labels |
| context/store.ts AVAILABILITY (:48), contact-URL regex (:117), contactText (:216-223) | hours and contact claims |
| crawler.ts KEY_PAGE_PATTERN (:34); packs.ts ARTICLE_URL (:22); facts.ts ARTICLE | listed-first order; page roles |
| pricing/model.ts rules-page Jev (:328) and page-text hash (:325) | term slots; a price-claim hash |
| multi-tenant/business-audit.ts regexes (:19-40) and its business-info.json / auto-context-notes.json (no live reader; tenant-manager stopped injecting them) | absent slots |
| capability-index.ts regionOf on address text (:45) and the GENERIC title regex (:105) | the structured postal field; capability kinds |
| chat.ts `/\d/` (:784); contact regexes (:867-869, :1157, :1167-1169, :1229); privacy keywords on the question (:1601-1612); full/ours (:1005-1015), simple/allOurs (:819-836), hasPricesFor (:1395), offeredForForm (:1480) on resolved turns; the "no item" fact (:986-998) unless the offer is complete | section 4 |

**Merge:**
- confirmItems + verifyFields -> S4;
- dedupe + name-keyed mergeItems -> S5;
- profile-verify shownOnPage -> the typed-against-visible rank;
- key facts (facts.ts, off since the 2026-10-27 A/B) are retired.

---

## 4. How the chat uses it per turn

### 4.1 Switches

- A tenant in mode `on`, with RECORD_CHAT=on and a published record, runs the record path.
- The admin variant `record` (`x-test-variant`, like `pricing` and `facts`) runs it for one request on any tenant with a published record.
- Otherwise today's path runs unchanged.

### 4.2 The turn, step by step

1. **Router** (router.ts:49-79). Unchanged; no new questions.
2. **Split** (projects/broadcast.ts splitNeed). Now runs on every question turn; today it runs only for offer questions (chat.ts:896, :910). It is stored per request as today, and runs in parallel with the first search.
3. **Entry match** (new record/match.ts matchEntries). Reuses matchItems' pinned deepseek-v4.1-flash call, shortlist and 1-hour memo. Per part it returns entry ids, related ids and inputs, plus the customer's date and customer type. It runs in parallel with the per-part searches and page scoring.
4. **Select** (record/select.ts selectForTurn, code). Builds the lines, the coverage per part, the computed lines and the pages to reserve.
5. **Coverage and routing** (code). Decides answer, network, agent or hand-off per part.
6. **Packs** (packs.ts). Candidates come from the record's page set; each part's evidence page is reserved first.
7. **Prompt.** The card, the lines, the packs; the other sections as today.
8. **Writer** (Haiku 5.5). Words everything.
9. **Checks.** The same two calls, with the record's lines among the sources, plus the `stale` and `gave_<id>` questions.
10. **State and demand.** Focus ids, contacts given, the running total; record_demand counters.

### 4.3 The entry index and the matcher

`recordIndex(record, today)` gives the matcher one line per entry:

```
i12 (item, ours) Biały Wieniec Pogrzebowy | Florystyka funeralna | Średni 1090 zł, Duży 1690 zł, Królewski 2589 zł [inputs: pieces]
c3  (category, ours) Rusztowania aluminiowe | 6 priced items
f7  (faq) "Czy dowozicie na cmentarze?"
t5  (terms: delivery) delivery zones and fees [zone: z1 do 10 km - Mokotów, Śródmieście, Ochota, Wola, Wilanów; z2 10-20 km]
t9  (terms: payment, online orders) payment methods and prepayment
l2  (place) Sklep, ul. Puławska 38 - hours
k1  (contact: orders) +48 731 865 337
x2  (not ours) "W cenę nie wliczony jest alkohol i muzyka"
n4  (not stated) opening hours of the shops
p6  (promotion, ended 31.10.2026) Premium Floor Royale 134,95 zł/m²
```

**Pool sizes:**
- items: as today (80 direct; above that, the vector shortlist up to 100; for shops, today's shopProducts shortlist);
- FAQ entries: 30 direct, else the 15 nearest per part by bge-m3;
- terms, places, contacts, exclusions and absences: all of them, up to 60;
- promotions: current ones, plus those ended within the last 60 days, labelled;
- the focus ids of earlier turns (up to 12): always in the pool, which fixes dworekstaropolski-1 T2.

**Prompt growth.** The matcher's prompt gains one sentence: entries are items, FAQ answers, terms, places, contacts, things we do not do and topics our site does not state, and for each part it gives the entries that are what the part asks for or that answer it. Its input vocabulary (quantities.ts INPUT_HELP) gains `date` (YYYY-MM-DD), `zone` (one of the zone ids listed on the line) and `customer` (private or business). "Attributes asked" is not needed: a picked item brings its whole card, and an absent topic is an entry of its own.

**Output:**

```json
{"parts":[{"part":0,"ids":["i12"],"related":[],"inputs":[{"id":"i12","input":"pieces","value":1}]},
          {"part":1,"ids":["t5"],"related":["k1"],"inputs":[{"id":"t5","input":"zone","value":"z1"}]}],
 "date":null,"customer":"private"}
```

If the matcher fails (null), the turn runs today's path, with the card still in the prompt.

### 4.4 Selection and the lines (code)

**Per picked entry:**
- **item, package, variant:** its current claims; its variants with prices; the add-ons whose applies_to covers it or its category; resolved legend values; promotions current for it; terms scoped to its category, location or channel; its coverage kind; its scoped contact.
- **category or capability:** its priced items, at most 10, cheapest first. rentbud-3 gets the towers.
- **term:** its current values with their conditions. If the matcher returned a zone, that zone is picked.
- **faq:** the question and its answer blocks, word for word.
- **place:** address, hours with today's status, special days, contacts.
- **contact:** displayed value, role label, hours.
- **exclusion:** the site's sentence, word for word.
- **absent:** "Not stated on our site: <slot>", or "Not found in the <n> pages we read (<m> listed pages not read)".
- **a named ended entry:** "<name> - ended on <date>", with its last value marked not current.
- **an undated promotion,** named: "no end date stated, on our site since <date>".

**Validity:**
- Values are current for today.
- A customer date inside a future period picks that period.
- With no customer date and several seasons, the current season is given and the others are listed by label.

**Conditions** are evaluated on the inputs. An unknown input keeps every branch, each with its condition.

**Conflicts:** the preferred value first; alternatives as "also stated on <page>"; unresolved ones as "two of our pages differ".

**Quotes.** Each value carries its evidence: the whole cited block in quotation marks, up to 300 characters. A longer block is never cut. Instead the line gives the value and the page title, and that page is reserved in packs, so the writer still sees the full sentence.

**Budget: 4,000 characters.** When the lines are over budget, related entries go first, then the quotes of alternatives. A part's own picked entries are never dropped.

### 4.5 Coverage, routing and network gating (code)

| Coverage label | When | Reply gets | Network | Agent | Hand-off offer |
|---|---|---|---|---|---|
| own_priced | an own item with a price, a variant price or a legend price | price lines + computed lines | no | only for multi-step work no program or arith can price (measuring, design) | no |
| own_unpriced | an own item or capability without a price | what we know + "no published price" + the scoped contact or form | no | no (decision 1) | once, a quote request |
| by_partner | ours, delivered by a named partner | the offer as the site describes it, with the partner named | no | no | as own_unpriced when unpriced |
| recommended | the site only recommends a business for it | the site's recommendation as a line | only if the router's intent is elsewhere | no | no |
| excluded | an explicit exclusion | the site's sentence + what we offer instead | yes, for this part's Polish text, need >= 0.5 | for a priced calculation of this part only | no |
| not_listed | an offer part with no entry, and complete.offer | "not in our offer" + related entries | yes, as excluded | as excluded | no |
| answered | a term, place, contact, FAQ answer or identity entry | the entry's lines | no | no | no |
| not_stated | an absent topic, every listed page read | "not stated on our site" + the topic's contact | no | no | once, pass the question on |
| unclear | no entry, an incomplete offer, or not_read | today's path for this part: its own search, page scoring, the full/ours call | as today | as today | as today |

**What this replaces:**
- The network block is used only for parts labelled excluded or not_listed, or when the customer asks for recommendations. A part the business covers never gets competitors. This replaces the "ours" >= 0.8 cut (chat.ts:1045) and the outOfScope < 0.35 cut (:1014) on resolved turns.
- **Calculation turns** (chat.ts:782-840). Every part own_priced and computed means it is answered in the chat (simpleCalc). own_unpriced parts are answered in the chat. Only excluded or not_listed parts with a price asked, or multi-step priced work, go to the agent. The `/\d/` test becomes "the matcher returned a quantity, a size or a date for some part". simple/allOurs and hasPricesFor are not called.
- **Order forms.** A form starts only when every offer part is own_*. This replaces offeredForForm (chat.ts:739, :1480).
- **The full/ours Jev call** (chat.ts:1005-1015) runs only when some part is unclear. BEHAVIOUR.partial is set only for unclear parts; resolved parts carry their missing detail as a line.

### 4.6 Quotes and computed lines (code, record/arith.ts, unit-tested)

- **Capacity against the quantity asked.** Komfort covers 5 services; 6 asked = 3000 + 1 x 500 = 3500 zł; Premium covers 7 = 4200 zł. Above the standard with no extension price on the site: "no rate on our site".
- **Durations in the price's own unit.** A year on a monthly price is 12 x 149 = 1788 zł; whisp-1's 13 months came from recipe.ts:133, which counts a month as 720 h, and it is fixed there for months. Doby are counted from pickup to return: Saturday about 8:00 to Monday about 8:00 = 2 doby = 240 zł.
- **Minimums.** 2.5 m³ and 3.7 m³ are both below the 4 m³ minimum.
- **Deposit and remainder.** 800 zł now, the rest after the wedding. "Około 30%" stays hedged.
- **Thresholds.** Free shipping from 500 zł; a promotion tier from 1899 zł.
- **Conditions on the customer's numbers.** 60 guests on a Saturday gives 2000 zł, not 100 zł.
- **Season row by the customer's date.**
- **Zone fees and add-ons** are summed only when every part is a fixed amount: 1090 + 60 + 30 = 1180 zł.
- **Sibling tiers.** Standard 5000 + plener 1500 = 6500 PLN, shown next to 3500 + 4 x 500 + 1500 = 7000 PLN.
- **A running total** across turns, in the conversation state (liliowa-1).

**The quote program** (pricing/model.ts quoteResult, :408) stays the authority for whole quotes where it exists. When both the program and arith price the same item, code compares the totals:
- equal: the program's lines are used;
- different: neither total is given ("no total computed for this request"), and the disagreement is logged for the panel.

With RECORD_PRICING the program is built from record ids, so the two converge.

### 4.7 Packs (packs.ts, chat.ts)

- **Candidates.** candidatePacks (:62-92) takes the allowed page set: primary and pagination pages of the record. Translation copies, pagination copies, alias URLs and stale vectors from earlier scrapes (kamilkozielewicz's slash twins) drop out. A page whose own period ended keeps its place, titled "Ended (valid until <date>):", the way articles are titled today (:172).
- **Reserved pages.** renderPacks (:155-177) takes a reserved list and fills it first: each part's best evidence page, plus the previous turn's evidence pages. Today those are kept only on follow-ups (chat.ts:933).
- **Per-part search.** Each part without a record entry gets its own search, run in parallel, and its best page is reserved. This replaces the single joined-parts search (chat.ts:912-924).
- **Partial scores.** scorePacks returns partial scores. A failed batch leaves only its own packs unscored, ordered by search (:135).
- **Unchanged:** the 40k budget, the top-4-at-0.5 fill after the reserved pages, and article handling (now by page role).

### 4.8 What the model sees

The system prompt, in order:
1. The first line, unchanged.
2. **## About us**: `renderCard(record, now)`, at most 2,500 characters. It replaces renderOfficialInfo (chat.ts:1079) with its AUTHORITATIVE paragraph and the contactText.
3. **## Answers from the owner**: unchanged until notes are migrated. Owner claims also appear in the card and the lines.
4. **## About this chat**: owner mode, from the record's counts (4.10).
5. **## For this message (checked against our pages)**: the lines, at most 4,000 characters.
6. **## Our information for this conversation**: the packs.
7. Network, pages, state, Now, What to do, Rules: unchanged.

No new rule is added. Rules chat.ts:1100-1101 (branch contacts, two values) are candidates for removal, since locations and conflicts are now explicit, but only if a blind pair shows no loss.

**The card.** Code renders structure as labelled lines for the model, as renderItem does today. When the card is over budget, it drops whole lines in this order: conflicts, promotions, terms after the first four, places after the first (names only). A line is never cut.

```
## About us (our record, checked against our pages, read 3 November 2026)
- Kwiaciarnia Miłość Sp. z o.o., NIP 5214154370, KRS 0001225239
- Shop: ul. Puławska 38 lok. 39, 02-512 Warszawa - every day 9:00-21:00 (today, Wednesday: open until 21:00)
- Phone (orders, every day 9:00-21:00): +48 731 865 337 | E-mail: biuro@kwiaciarniamilosc.pl
- Online orders: full prepayment, BLIK or card; in the shop also cash
- Same-day delivery for orders until 17:00; delivery fee by zone
- Prices: gross
- Two of our pages differ: paying by transfer (Balony i dodatki, Regulamin)
```

**The lines** (kwiaciarniamilosc-2, turn 2):

```
## For this message (checked against our pages)
Part 1 - biały wieniec pogrzebowy, najmniejszy, z szarfą:
- Biały Wieniec Pogrzebowy (our product): Średni 1090 zł, Duży 1690 zł, Królewski 2589 zł - "od 1 090,00 zł do 2 589,00 zł" [Biały Wieniec Pogrzebowy]
- For every composition: szarfa z napisem +60 zł - "Do każdej kompozycji możesz dodać szarfę z napisem (+60 zł)" [Florystyka funeralna]
- Standard lead time: 24 hours from the order's confirmation - "Standardowy czas realizacji to 24 godziny od potwierdzenia zamówienia"
Part 2 - dostawa na Cmentarz Wolski:
- Delivery, zone up to 10 km (Mokotów, Śródmieście, Ochota, Wola, Wilanów): 30 zł; 10-20 km: 58 zł [Dostawa i płatność]
- The customer's place falls in the zone up to 10 km (read from the message)
Computed for this request: Średni 1090 zł + szarfa 60 zł + zone up to 10 km 30 zł = 1180 zł
Not stated on our site: a guaranteed delivery hour
```

### 4.9 Checks

- **Sources.** verifySources (chat.ts:1656) gets the card, the lines and their evidence blocks in place of renderOfficialInfo. The fact check reads what the writer read (next-plan fix 6). A correct "od 1090 = najmniejszy" or 1788 zł is now supported.
- **`stale`.** When ended, superseded or hidden values exist in the used packs or the lines, the existing check call (chat.ts:1191) gets one more question: "Does `reply` state as current any of: <those values>?" At >= 0.6 the draft is blocked and rewritten.
- **`gave_<id>`.** One question per card contact: "Does `reply` give this contact of ours: <display>?" These answers replace:
  - hasContact and givesKnownContact, digit and e-mail regexes on reply text (:867-869, :1167-1169);
  - hasPhone and hasEmail over the facts text (:1157), which become "the card has a phone or e-mail contact";
  - the callUs digit regex (:1229);
  - the "our own contact as a network business's" test (:1226).
- **needContact** asks for the part's scoped contact (the sales line, the room-booking line), unless PackState.contactsGiven already holds it. This replaces the once-per-conversation flag that dropped needed lines.
- **The privacy keyword filter** on the customer's question (:1601-1612) is not used on record turns; legal pages are a page role.

### 4.10 State, demand, owner mode

- **PackState** (packs.ts:180) gains: `focus` (up to 12 entity ids), `contactsGiven` (contact ids), `quoteLines`, `customerDate`, `lastEvidencePages`.
- **Demand.** After a real customer turn (not probes, not owner mode), code increments record_demand: `asked` for each entity or slot picked, `unanswered` for parts left not_stated, not_read or unclear. Today only turns with no answer at all become gaps (chat.ts:1181). The 54 'partial' turns never reached the owner.
- **Owner mode.** "About this chat" (chat.ts:1070-1077) states the record's counts, for example: "87 pages read on 12 October 2026, 143 offer items (118 priced), 9 standing terms, 2 contradictions found on the site, 3 standard topics the site does not state". NIP and KRS come from the card, or "not on our website". "The number you have is wrong" gets every number with the pages it appears on.

### 4.11 Calls per turn

There is no new kind of call:
- Split and matcher (deepseek) now run on every question turn, at a few hundredths of a cent each.
- Up to three Jev calls go away on resolved turns: full/ours, simple/allOurs, hasPricesFor or offeredForForm.
- The writer's prompt stays about the same size. The card (<= 2,500 characters) replaces up to about 6,500 characters (official info, the AUTHORITATIVE paragraph, contactText), and the lines add up to 4,000.

---

## 5. The owner panel and the salesperson's demo

### 5.1 "Co wie Twój czat" (public/dashboard.html, a new top section)

This section becomes the panel's main view. The raw chunk list moves under "Źródła". The layout is one column, for a phone.

**Header (data only).** For example: "Przeczytane: 87 stron (12.10.2026) · Oferta: 143 pozycje, 118 z ceną · Warunki: 7 z 10 · Do sprawdzenia: 4 · Ostatnia zmiana na stronie: 3.11".

**Do sprawdzenia.** At most 10 items, ranked by code:
1. Topics customers asked about that are empty or went unanswered, with the count and example questions from the intent engine. For example: "Klienci pytali 5x o formy płatności - strona tego nie podaje".
2. Unresolved contradictions. For example: "Nocleg: 220 zł (polska strona) i 140 zł (angielska) - czat podaje 220 zł".
3. Ended promotions still visible on the site.
4. Values that changed on the site after the owner confirmed them.
5. Key facts not yet confirmed.

Each item takes one tap: Zgadza się / Popraw / Ukryj / Uzupełnij.

**Cards:** Firma · Kontakt i godziny · Oferta i cennik · Warunki · Ważność i promocje · Sprzeczności · Czego nie ma na stronie · Źródła i świeżość · Zmiany na stronie.

**Every value shows:**
- its source link, which opens the page's block text with the sentence highlighted, from blocks/<page>.json (no live fetch);
- its origin ("ze strony", "poprawione przez Ciebie", "Google Maps");
- its status ("zakończona 31.10", "sprzeczne", "tylko na angielskiej stronie");
- how often it was asked.

**Edits.**
- Forms are generated from the attribute or slot schema: selects for enums, numbers, dates, rows for variants and add-ons. An empty slot is filled through its own form (payment methods as checkboxes, a deposit amount with "refundable").
- An edit is saved in record_edits as an owner claim: structure, not a free-text note. It applies at once, in the way setContextNotes does (serve-multi-tenant.ts:2211-2232).
- If the site later states something different, the panel shows "your site now says X, your correction says Y". The owner value stays until the owner chooses.

**Twoimi słowami.**
1. The owner types a sentence. POST /api/dashboard/record/parse sends it to an LLM, which proposes structure.
2. An LLM writes a one-line read-back, for example "Zapisuję: zadatek 800 zł, reszta do kilku dni po weselu".
3. When the owner confirms, the owner's sentence becomes the claim's evidence.

In the panel's own test chat, "ten numer jest zły, prawidłowy to ..." becomes a pending edit for the owner to confirm. This never happens from the public widget.

**First login after a claim: "Sprawdź 5 rzeczy".** Main phone, hours, price basis, payment, delivery or area: about two minutes. The record then stores keyFactsConfirmedAt.

**Gaps become slots.** Today's "Pytania bez odpowiedzi" (free text into contextNotes) is grouped by slot, for example "Płatność - 5 pytań" or "Cena: Tynk maszynowy - 3 pytania". The answer form is that slot's own form. Free text remains for things outside the schema (slot `other`). An LLM proposes edits from the existing notes, and the owner confirms them; no note is deleted automatically.

**Inquiries.** Each inquiry shows the record items it matched and the computed lines, for example "Biały tort weselny z kwiatkami SH-1102, 8 kg (min. 7 kg), 160 zł/kg -> 1280 zł". It also shows what the record lacked, for example "dowóz do Józefowa - brak w warunkach", with one tap to add it. The form fields are the business's own: a photographer is no longer asked for a delivery address.

**Corrections reach every surface:** the chat, the quote program, the network records, the form and the /site page.

### 5.2 Routes (scripts/serve-multi-tenant.ts; owner auth unless stated)

- GET /api/dashboard/record - the view model: sections, attention list, counts.
- GET /api/dashboard/record/source?page=&blocks= - block text with highlights.
- POST /api/dashboard/record/edits - {target, action confirm, correct, hide or add, value}; undo by id.
- POST /api/dashboard/record/parse - owner text -> proposal + read-back (about $0.0005 a call).
- POST /api/dashboard/record/conflicts/:id - pick a value, or "both - different conditions" (adds the condition).
- POST /api/dashboard/record/read-unread - claimed owners only: a build that reads the pages the cap left unread.
- POST /api/admin/record/:id (build), GET /api/admin/record/:id (stats), POST /api/admin/record/:id/mode (off, shadow, on) - admin.
- GET /api/demo/:tenantId/record - read-only drawer data. Hooks only with the demo pass or admin login-as.

### 5.3 The salesperson's demo

**The drawer.** The /demo/:tenantId page (serve-multi-tenant.ts:692) gets a read-only drawer "Co wie ten czat":
- record counts;
- the price list as the chat sees it (for example K1/K2/K3 per kg with minimums);
- the terms found, with their quotes;
- contacts by role;
- hours.

**"3 rzeczy do pokazania".** Shown only with the salesperson's demo pass or admin login-as. Code builds it from the record:
- standard terms missing for the trade;
- contradictions on the site;
- ended promotions still visible;
- pages the cap left unread.

These are grounded hooks about the prospect's own site, for example: "Przeczytałem 42 strony 3 listopada - 6 salonów z godzinami, NIP, 214 pozycji z ceną i 3 sprzeczności na stronie". They never appear on the public link, so an unclaimed demo is not read as criticism.

**Elsewhere:**
- The claim result (public/claim/index.html:254-263) shows record counts instead of "Fragmenty wiedzy".
- The demo chat's "About this chat" states the real state: a demo, the pages read, the date.
- Labels are static i18n and never say "asystent AI".
- Any new e-mail (a digest, a "your chat knows" summary) needs the owner's approval of the template first.
- Measurement is first-party: drawer opens per demo visit, claims after a drawer view, owner edits within 7 days.

### 5.4 How it helps run the business

- **Customers stop getting wrong information:** ended promotions, 2016 English prices, the wrong department's number. That means fewer calls correcting wrong expectations.
- **The record is an audit of the owner's own site:** contradictions, stale language versions, a NIP only in the privacy policy, missing payment terms (a gap on 12 of 12 pilots). Fixing them once fixes the chat and the website.
- **Answers become reusable structure.** Answers to absent topics feed the order form, the quote, the network index and the replies, instead of free-text notes.
- **Price list and terms in one place, with a daily change feed.** For example: "3.11: Komfort 2500 -> 3000 zł, czat już używa nowej ceny". This gives the owner a standing reason to keep the 149 zł panel.

---

## 6. Freshness, storage, cost and latency

### 6.1 Incremental updates

- **A re-scrape reads only changed pages.** Reader and verifier outputs are keyed by content (3.10). An unchanged page reuses both, so a re-scrape reads only changed pages, usually a few percent.
- **Reconcile runs whole.** S5-S8 run for the whole tenant: code, in seconds, with Jev only for new name-only pairs.
- **A schema or prompt change** rebuilds from stored blocks, without crawling.

### 6.2 The nightly freshness job (record/freshness.ts, RECORD_FRESHNESS)

- **Runner.** One runner holds `record_lease`. It runs 01:00-06:00 Warsaw time, only while the scrape queue is empty, and resumes per tenant.
- **Watched pages,** at most 15 per tenant:
  - pages holding price, promotion or term claims, ranked by demand;
  - home and contact;
  - plus the sitemaps, to find new pages such as a new promotion.
- **Check.** A conditional GET (If-None-Match / If-Modified-Since; fetcher.ts fetchPage gains both options) plus the sitemap lastmod:
  - a 304, or an unchanged blocksHash: only `seen.last` is updated;
  - a changed page: segmented, read and verified again; the tenant is reconciled and published, and an entry goes into the change feed;
  - a page that 404s or leaves the sitemap: its claims become withdrawn.
- **Frequency.** Daily for claimed or paying tenants, weekly for unclaimed demos. At most 2 requests at a time per host; a host is skipped after 3 throttles (the kwiaciarniamilosc 429 lesson).
- **Expiry needs no job:** status is computed on load and on every turn, so "promocja do 31.10" ends on 1.11 even if the site never changes. aniatkaczyk's 2026-11-03 change would reach the chat the next morning.

### 6.3 Storage

Measured basis: the 26 local tenants hold 8,170,891 characters of page text (median 36,829 per tenant).

| Item | Size |
|---|---|
| Blocks | About 1.5x the text: about 12 MB for the 26 (median about 55 KB per tenant, romax about 5.5 MB) |
| Record | About 0.6 MB per million characters read (average about 200 KB) |
| Cache | About the same again |
| Fleet of 2,601 | Under 3 GB, about $0.04 a month on R2 |
| D1 | record_edits small; record_demand about 10-50 rows per tenant per day |

### 6.4 Build cost per business and for the fleet

**Assumptions,** to be measured with the provider's usage numbers in P1:
- Haiku 5.5 at $0.10 / $0.50 per M tokens; Jev at $0.042 per M input tokens (llm/jev.ts:5);
- about 3.3 characters per token for Polish page text;
- reader output about 0.6x the text tokens;
- 1,500 prompt tokens per 8,000-character window.

| Per million characters of page text read | Tokens | Cost |
|---|---|---|
| Reader input (text x 1.15 + prompt per window) | about 0.56M | $0.056 |
| Reader output (claims JSON) | about 0.18M | $0.09 |
| Jev verification (cited blocks per batch + questions) | about 0.56M | $0.024 |
| Repair round, page roles, pairing, name pairs | - | about $0.02 |
| **Total** | | **about $0.20** |

| Tenant (local data) | Page text | Record build |
|---|---|---|
| liliowa_pl | 5,103 | $0.001 |
| sosnowydwor_com_pl | 37,161 | $0.007 |
| dworekstaropolski_com | 126,023 | $0.025 |
| bostabeton_pl | 306,243 | $0.06 |
| sweet_home_pl | 332,361 | $0.07 |
| www_ostap_pl | 634,603 | $0.13 |
| empro_pro (2,347 products typed from the store API, $0) | 1,184,255 | $0.24 |
| www_romax_waw_pl (499 pages; RECORD_MAX_PAGES 300, listed and primary first) | 3,715,474 | up to $0.74 |
| **26 local tenants** | 8,170,891 | **about $1.6** (median $0.007, mean $0.06) |

**Fleet:**
- **Active (1,089 tenants):** $25-70 once. The local 26 include the largest pilots, so the fleet's mean is likely lower; it is measured on the first wave of 50 before going further.
- **All 2,601 tenants:** $60-170.

**Plus the re-scrape each existing tenant needs** (no blocks are stored today):
- crawling and embeddings: Workers AI, small;
- chunk labels: $0.16 per thousand chunks (about $0.05 per average tenant, about $55 for the active fleet). Reusing labels by chunk id leaves only changed chunks, about $5-10;
- the 8 audit probe questions: none, since a re-scrape of a live bot skips them (serve-multi-tenant.ts:2058-2064).

**Afterwards:**
- Freshness: about $0.1-1 a day for the fleet. Conditional GETs are free; about 1-3% of watched pages change, at about $0.002 per page re-read.
- The quote program (Opus, about $0.57 per part): rebuilt only when the price-claim hash changes. The first RECORD_PRICING switch rebuilds each existing program once, and only tenants that have one.

### 6.5 Cost per turn

Calls are unchanged in kind (4.11):
- Split and matcher on every question turn: a few hundredths of a cent.
- Up to three Jev calls saved on resolved turns.
- The writer's prompt is about the same size.
- Net: about the same OpenRouter cost per turn, and slightly lower Jev cost per turn.

### 6.6 Latency

| Step | Today | With the record | On the first-token path |
|---|---|---|---|
| Router (Jev) | 0.4-1.0 s | unchanged | yes |
| Split (deepseek, stored per request) | offer questions, 0.5-1.0 s | every question turn | parallel with the first search |
| Matcher (deepseek) | offer questions, about 0.9 s | every question turn, after the split, with a larger pool (+1-3k tokens) | parallel with the per-part searches and scoring, which also wait for the split |
| Searches (Vectorize) | 1 + 1 joined | 1 + one per unresolved part, in parallel | yes, 0.3-0.6 s |
| Page scoring (Jev) | 0.4-3 s | unchanged, fewer candidates | yes |
| Record and evidence | - | the record is in memory with the chat; evidence blocks 50-150 ms cold, from R2, parallel with search | no |
| Select, coverage, arith | - | under 5 ms | negligible |
| full/ours (Jev) | 0.4-3 s on answered turns | only when a part is unclear | removed on resolved turns |
| Quote read (Haiku) | 2-3 s, price turns with a program | unchanged | as today |

**Gate:** first token median <= 3.0 s and p90 <= 4.5 s, no slower than iteration 4. Removing the full/ours call from resolved turns should bring p90 to about 4.0 s. If P4 shows the matcher on the critical path, the split starts at routing time (next-plan fix 11).

**Build latency:**
- about +1-3 minutes for a typical 60-page site (16 pages at a time, verification per page in parallel);
- a 100,000-character price list is about 13 windows read in order, 3-5 minutes.

The build runs after the vectors are live. A new demo answers on today's path and switches when the record publishes.

### 6.7 Memory

- Blocks are written to R2 page by page during the crawl.
- Evidence blocks are loaded lazily, per page.
- The record sits in the chat instance, bounded by the TenantManager LRU (TENANT_CACHE_MAX, 50 tenants), within a budget of about 100 MB of records.

---

## 7. Rollout and measurement

### 7.1 Phases

| Phase | What | First (one case) | Measured by | Gate to the next | Cost |
|---|---|---|---|---|---|
| P0 | src/record/*, flags off, clean() and mergeItems changes, unit tests on saved HTML fixtures, offline crawl report | one fixture per feature | tests; crawl report for the 21 tenants (groups, primary language, listed pages unread under the cap, cap use) | tests green; report read by hand | $0 |
| P1 | Build ONE tenant locally, writing nothing to production: dworekstaropolski_com. Then kwiaciarniamilosc_pl, also alone | dworek | record.json read by hand against the ground truth (7.2) | every expected value right, or explained and fixed | about $0.03 each, plus about $0.01 Jev |
| P2 | Offline build of the 21 eval tenants (on the VPS, which survives Mac sleep). Reader and verifier outputs go to R2 `record-cache/`, which nothing serves | romax last (largest) | about 150 expected data facts and about 40 data traps, from the cases' must/must_not lines (evals/record/expected/<tenant>.json, written once by an LLM, read by a person). One LLM call per tenant pairs fact ids with claim ids; code compares values and status | facts present, verified and current >= 90%; traps never current: 100%; known conflicts found (dworek ceremony, kamilkozielewicz travel 40 vs 50 km, kwiaciarnia transfer, empro dispatch 24 h vs 2 days); coverage kinds right (zajacfoto film partner_delivered, VOCART recommended, angelikasolecka animations not_offered, bostabeton HydroBeton own); absences right >= 95%; card p95 <= 2,500 characters | about $1.7 build, $0.1 pairing, about $1 for the deepseek reader comparison (one tenant first) |
| P3 | Push with the queue empty, RECORD_BUILD on. The 21 tenants go to shadow and are re-scraped in a night window (S0 applies to them) | one tenant re-scraped first | production record vs the offline one: cache hits; labels reused | same claims except on changed pages | about $0.2 |
| P4 | Reply test: the data cases with variants current and record, played in the same run. romax-1/-2, sweethome-1/-3, kwiaciarniamilosc-1/-2, dworekstaropolski-1/-3, empro-1/-2, aniatkaczyk-1/-3, bostabeton-1/-3, dachywarszawa-2/-3, zajacfoto-3, angelikasolecka-3, liliowa-1, kamilkozielewicz-2, rentbud-3, whisp-1, helsen-3 | dworekstaropolski-1, record only (3 turns) | srccov.py (re-created in evals/judged/, $0); 'partial' share; first token from run.json; every reply and trace read; route test with evals/routing/run.ts on the first messages of djmw-2, betonlazy-1/-3, bostabeton-2/-3, zajacfoto-3, plus controls romax-3, ostap-3, sosnowydwor-2, liliowa-3 | source share >= 0.65; 'partial' on <= 25% of turns; no slower; no network or agent start for a covered part | $0.01; then about $0.25 OpenRouter + $0.5 Jev for both variants; route test about $0.02 |
| P5 | Milestone: all 63 cases with variants current and record in one run, 3 judge lenses, blind pairs | check the OpenRouter and Jev balances first | 7.3 | 7.3 | about $0.6 OpenRouter + $1 Jev + the judge agents |
| P6 | Production: RECORD_CHAT on; mode on for tenants that passed; new onboardings build records; backfill in night waves of claimed and paying tenants, then active demos | 1 tenant, then 10, then 50 | per-tenant stats line (pages, claims, rejected, conflicts, absent, cost); the knowledge audit's data checks; the first 50 sampled by hand | per-tenant cost as estimated; no audit regressions | about $0.06 per tenant on average: 50 = about $3, 1,089 = $25-70 (+ $5-10 labels), up to 300 tenants a night, cost stated per wave |
| P7 | Freshness on | aniatkaczyk_pl alone | a week's report: changed pages per day, false changes, cost per day | false changes under 5% | $0.1-1 a day |
| P8 | RECORD_PRICING: the quote program built from the record | sosnowydwor_com_pl | its verification cases; its cases' price turns | checks agree as today | $0.6-2 per tenant with a program |
| P9 | Owner panel and demo drawer; can start alongside P6 | the owner's own tenant (whisp_so) | first-party events: drawer opens, edits, gaps closed within 7 days | the owner's sign-off | parse calls only |
| P10 | Delete the replaced code (3.11) once no tenant has needed the old path for 2 weeks | - | the list in 3.11 is empty; tests | - | $0 |

### 7.2 Smoke steps (P1, read by hand)

**dworekstaropolski_com:**
- 285 zł per person for Sezon 2027, Saturday, 50-69 guests;
- ceremony 2000 zł otherwise and 100 zł above 85 adults, with "od 500" and "500-2000" flagged as alternatives;
- deposit and its refundability;
- room 220 zł, breakfast 35 zł, breakfast hours per day;
- the EN 2016 list ended, and /en/accomodation/ superseded;
- Sala Świerkowa up to 50 guests;
- pets absent (not_stated);
- the "Wesela, imprezy" and "Rezerwacje pokoi" lines with their roles.

**kwiaciarniamilosc_pl:**
- NIP and KRS;
- full online prepayment by BLIK or card, and cash only in the shop;
- the transfer contradiction, unresolved;
- the wreath's three typed variants, and the sash as an add-on;
- the two delivery zones and the 17:00 cutoff;
- the /uk/ pages grouped as translations;
- /regulamin/ and /dostawa-i-platnosc/ read by the completeness pass.

### 7.3 The judged measurement

**How it is run:**
1. Both variants are played in the same run (`run-iter.sh` gains `VARIANTS=current,record`; today it passes `--variants current` first, and run.ts reads the first value). Both see the same live sites at the same time.
2. run.json is split by variant.
3. `mkpair.py A B <out> 4 <seed>` + `pair-workflow.js` (2 judges per batch) + `pairscore.py`.
4. `cleanup-reval.mts` after the run.

**Gate for switching tenants on:**
- **Pairs.** New wins at least 1.5x old losses overall, and more wins than losses on the 39 low conversations.
- **Regression set.** On the 24 regression conversations: losses <= wins + 2.
- **Source share** >= 0.65; **'partial'** on <= 25% of turns.
- **Blocked drafts** on <= 31% of turns.
- **No covered part** sent to the network or the agent.
- **First token** median <= 3.0 s, p90 <= 4.5 s.
- **P2 record targets** met.

### 7.4 Backward compatibility and rollback

- The record writes the old files, so consumers that do not know it keep working.
- Tenants without a record run today's path.
- owner_set values and panel answers are imported as owner claims; contextNotes stay as notes too.
- **Rollback, either way:**
  - globally: RECORD_CHAT off;
  - per tenant: mode back to shadow, plus offer.legacy.json restored.
- The quote program switches separately (RECORD_PRICING), after P2 shows the price claims are right.

---

## 8. Risks and the owner's decisions

### 8.1 Risks

| Risk | Mitigation |
|---|---|
| A wrong claim passes verification and then reaches every reply | Every line carries its source and its verbatim evidence. Alternatives are kept. The fact check still runs. Packs still carry the pages. The owner corrects it in one place |
| Strict verification drops true claims, so recall falls below today's items | One repair round for every family; derived legends; recall measured on 21 tenants before any switch; rejected claims listed in the panel; shadow mode keeps today's extractor |
| The reader misses content only JavaScript renders (PayU "Rata już od", stock, calendars), tabs without ARIA links, CSS-hidden panels, scanned PDFs | Typed sources first; a count check (links on a listing vs items found) flags gaps in the panel; what is missing stays absent, never guessed |
| Dates are hard (missing years, season labels, "do końca miesiąca") | A value ends only on an explicit date. inferredYear is marked. Undated stays undated. The read date shows in "About this chat". Freshness re-reads changed pages |
| Entity matching merges sizes or splits one item | Different codes or own URLs never merge; Jev only for name-only pairs; measured in P2 |
| The matcher becomes a selection point | The card does not depend on it. Packs and page scoring stay. A null result runs today's path. Answers are cached for 1 hour on a pinned provider. Accuracy is measured on the P4 asks |
| arith and the quote program disagree | Code compares the totals; on disagreement neither is given; logged for the panel |
| An always-on card over-informs | Headlines only, at most 2,500 characters; details come by selection; the customer lens watches reply length |
| Jev credits run out | Separate build key; a build waits, and the previous record stays live; the LLM fallback after 24 h; the balance checked before every wave |
| Fleet rebuild cost and queue time; a push drops jobs | Waves with stated cost; label reuse; resumable stages; the D1 queue re-enqueued at boot; pushes only with the queue empty |
| Render memory | Blocks streamed to R2; evidence loaded lazily; the LRU budget |
| A false "not stated" because the cap was hit | not_stated only when every listed page was read; otherwise "not found in the N pages read"; the unread pages are listed in the panel |
| Two places to edit during migration | The offer editor writes owner claims; offer.json becomes a view |
| The schema is too rigid | The "other" slot, reviewed only to add general slots |
| The prompt grows, or someone adds a regex "just here" | Fixed budgets; every added line must hold a blind pair; a code-review checklist item; the deletion list in 3.11 |
| Showing a prospect its own site's contradictions reads as criticism | Only with the demo pass or login-as; any e-mail needs an approved template |

### 8.2 Decisions the owner must take

1. **Agent rule 9** (next-plan decision 1). This design keeps the business's own items in the chat. Priced items are computed there; unpriced ones get "no published price" and the right contact. Only parts the business does not cover go to the network or the agent. This must be decided before the coverage gate is switched on. All three lenses scored the current behaviour lowest (djmw-2, betonlazy-1).
2. **Calculations held for approval on unclaimed demos** (next-plan decision 2). They never arrive. Choose: no agent on demos, or results released automatically on demos.
3. **The demo crawl cap.** ONBOARD_MAX_PAGES stays at 150, with listed pages first and 30 more for the completeness pass. RECORD_MAX_PAGES is 300 for claimed tenants. Or a higher cap for demos a salesperson creates.
4. **Spend.** Approve the backfill ($25-70, plus $5-10 for labels), the pace (300 tenants a night), RECORD_BUILD_DAY_USD (proposed $15) and the two separate build keys.
5. **Translation-only values.** Use them, marked "only on our EN page" (proposed), or ignore them.
6. **Undated promotions.** Shown only when named, with "no end date stated" (proposed), or never.
7. **Contradictions and missing terms on demos.** Only behind the demo pass (proposed), or never.
8. **Owner confirmation.** Must the owner confirm the 5 key facts before a paying business is switched on? Proposed: no; ask at first login.
9. **Freshness frequency.** Daily for paying tenants and weekly for demos (proposed), or another rhythm.
10. **contextNotes.** Migrated to typed claims through LLM proposals that the owner confirms (proposed), or kept as notes.
11. **Hold replies until checked** (next-plan decision 4). Unchanged by this design.

### 8.3 Not fixed by this design

- Problem 13: language and form-of-address slips.
- Problem 6: "never send a still-flagged draft" (the judges' fix 6).
- Problem 8: the per-conversation inquiry state record (fixes 8 and 9; the record supplies its fields and `takesInquiries`).
- Problem 10: detecting the owner over the whole conversation.

---

## Appendix A. Files to add and change

**New: src/record/**

| File | Functions |
|---|---|
| schema.ts | the types of section 2; ATTRS; TERM_SLOTS; STANDARD_SLOTS (per BusinessType); RECORD_SCHEMA |
| blocks.ts | `segmentHtml(html, url)`, `typedBlocks($)`, `segmentPdf(rows)`, `siteChrome(pages)`, `blocksHash(blocks)` |
| groups.ts | `pageGroups(pages, blocks)`, `primaryOf(group)`, `pageRoles(cards)` (Jev), `pairTranslations(cards)` (LLM) |
| read.ts | `readPage(page, blocks, known)`, `renderWindow(blocks)`, `parseRead(json)` |
| verify.ts | `verifyClaims(page, claims, blocks)` (Jev, build key), `repairClaims(...)` (LLM), `fallbackVerify(...)` |
| resolve.ts | `resolveEntities(entities, previous)`, `carryIds(previous)` |
| reconcile.ts | `rankClaims`, `validityStatus(validity, today, customerDate?)`, `classifyConflicts`, `deriveLegends`, `absentSlots`, `completeness` |
| views.ts | `toOfferItems`, `toOfficialInfo`, `toOfferPages`, `toPricingInput`, `toCapabilities`, `toInquirySpec` |
| store.ts | `loadRecord(tenantId)` (R2, `current.json`, 5-minute check), `saveRecord(record)`, `loadBlocks(tenantId, pageId)`, `cacheGet/cachePut`, the D1 tables |
| build.ts | `enqueueBuild(tenantId, reason)`, `buildRecord(tenantId, opts)` (S1-S8, resumable), `recoverBuilds()`, the lease |
| match.ts | `recordIndex(record, today)`, `matchEntries(query, parts, index, opts)` |
| select.ts | `selectForTurn(record, picks, today, customerDate)` -> lines, coverage, reserved pages, contacts |
| arith.ts | `capacityLine`, `durationIn`, `minimumCheck`, `depositLine`, `thresholdLine`, `conditionPick`, `seasonPick`, `zoneFee`, `siblingTiers`, `runningTotal` |
| render.ts | `renderCard(record, now)`, `renderLines(selection)` |
| owner.ts | `applyEdits(record, edits)`, `parseOwnerText(text)` (LLM), `readBack(proposal)` (LLM) |
| demand.ts | `countDemand(tenantId, selection, outcome)` |
| freshness.ts | `nightly()`, `checkTenant(tenantId)` |

**Changed:**

| File | Change |
|---|---|
| scraper/extractor.ts | extractMetadata: hreflang, rel next/prev, og:locale, published time; extractLinks: `region` |
| scraper/types.ts | PageLink.region; PageMetadata alternates, next, prev, postDate |
| scraper/crawler.ts | listed-first queue and round-robin children (replaces KEY_PAGE_PATTERN); completeness pass; lastmod kept; S1 in onPage |
| scraper/fetcher.ts | conditional GET options |
| scraper/catalogue.ts | wooItem and fromShopify keep variants |
| scraper/pdf.ts | rows as blocks on the record path |
| offer/store.ts | OfferItem optional fields; clean() carries them; mergeItems by rid; renderItem prints them |
| offer/search.ts | matchItems internals exported for match.ts |
| offer/quantities.ts | INPUT_HELP: date, zone, customer, guests/adults/children |
| offer/recipe.ts | months counted as months for per-month prices (:133) |
| offer/index-scrape.ts | skipped in mode on |
| context/store.ts | enrichChunks reuses labels by chunk id; page hashes passed on |
| multi-tenant/scrape-pipeline.ts | persists page hashes in context-meta (:265-270); enqueues the build; skips the offer indexer and business audit in mode on |
| multi-tenant/background-worker.ts | build jobs share the slots; `recoverBuilds()` at boot |
| multi-tenant/tenant-manager.ts | loads the record with the chat (`chat.setRecord`); evicts on publish |
| llm/chat.ts | the record path in chatStream (calculate, forms) and packsReply (selection, coverage, card, lines, reserved pages, checks); `verifySources` with the card |
| llm/packs.ts | candidatePacks allowed set and reserved packs; scorePacks partial scores; renderPacks reserved first; PackState fields; page role instead of ARTICLE_URL |
| pricing/model.ts | buildBusiness from toPricingInput; claim hash; term-slot pages instead of the rules Jev |
| network/capability-index.ts | records from capabilities; region from the structured postal field |
| flows/collect-store.ts | the inquiry form from toInquirySpec for record tenants |
| knowledge/audit.ts | dataChecks reads absent, conflicts and unread |
| scripts/serve-multi-tenant.ts | routes of 5.2; demo drawer; onScraped enqueue; reindexNetwork on publish |
| public/dashboard.html, public/claim/index.html | the panel section; record counts |
| render.yaml | RECORD_BUILD, RECORD_CHAT, RECORD_PRICING, RECORD_FRESHNESS, RECORD_BUILD_DAY_USD, RECORD_READER_MODEL, RECORD_MAX_PAGES, JEV_BUILD_API_KEY and OPENROUTER_BUILD_KEY (secrets) |
| evals | evals/record/expected/*.json and record-recall.mts; evals/judged/srccov.py; run-iter.sh VARIANTS; new evals/routing cases |
| tests | tests/record-*.test.ts on saved fixtures: dworek tabs, table columns, "nie wliczony", form options, hreflang, rel-next, slash/www/query copies, validity and condition math, zones, ranking classes, derived view shapes, arith cases (3500/4200, 1788, 6500/7000, 2.5/3.7 vs 4 m³, 1180, 17 100, 2 doby = 240, Royale ended on 2026-11-04) |

## Appendix B. Rows for docs/limits.md (added in the same commits)

| Limit | Value | Where | Why / status |
|---|---|---|---|
| Pages read by the LLM per site | 300 (RECORD_MAX_PAGES); listed and primary first, articles newest first | record/build.ts | romax 499 pages, local median 28. CHECK |
| Completeness pass | up to 30 declared pages beyond the crawl cap | scraper/crawler.ts | kwiaciarnia's regulamin and delivery pages unread. CHECK |
| Read window | 8,000 characters of whole blocks, 2-block overlap; windows of a page in order, 16 pages at once | record/read.ts | 16 = OFFER_WINDOWS_AT_ONCE. KEEP. Window size CHECK (vs 16,000 in P2) |
| Reader output | 6,000 tokens per window, complete objects salvaged | record/read.ts | as extract.ts. CHECK |
| Verification | <= 40 questions per Jev call; keep at >= 0.5; one repair round | record/verify.ts | 0.5 from bf84086 (confirmItems). KEEP. 40 CHECK |
| LLM fallback verifier | after 24 h of build-key outage | record/verify.ts | CHECK |
| Entity merge | bge-m3 >= 0.85 candidates; Jev >= 0.7 | record/resolve.ts | 0.7 = dedupe. KEEP. 0.85 CHECK |
| Copy page | >= 90% shared block hashes | record/groups.ts | liliowa ?start=N. CHECK |
| Site chrome | block on >= 40% of pages | record/blocks.ts | same as index-scrape. KEEP |
| Derived legend | >= 2 agreeing items, none disagreeing | record/reconcile.ts | Sweet Home K-codes. CHECK |
| Undated promotion | never current; shown only when named | record/select.ts | romax, empro. Rule |
| Ended entries in the matcher index | 60 days | record/match.ts | romax-2 T2. CHECK |
| Card | 2,500 characters, fixed drop order, lines never cut | record/render.ts | p95 measured in P2. CHECK |
| Per-turn lines | 4,000 characters; quotes are whole blocks up to 300 characters, never cut | record/render.ts | the "nie wliczony" lesson. CHECK |
| Matcher pool | items as today; FAQ 30 direct, else 15 nearest per part; terms, places, contacts, exclusions and absences up to 60; focus 12 ids | record/match.ts, packs.ts | CHECK |
| Watched pages | 15 per tenant; daily for claimed and paying, weekly for demos; 2 requests per host; stop after 3 throttles | record/freshness.ts | the kwiaciarniamilosc 429s. CHECK |
| History | current + 2 builds; change feed 365 days | record/store.ts | 365 = chat retention. KEEP |
| Build budget | RECORD_BUILD_DAY_USD 15; 300 tenants a night | record/build.ts | owner decision 4 |
| Demand window | 90 days | record/demand.ts | CHECK |
| Attention list | 10 items | panel | CHECK |
| offer.legacy.json | kept 30 days after switching on | record/views.ts | rollback. KEEP |