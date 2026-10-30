# Limits, thresholds and caps - with their traces

Every limit in the code (caps, thresholds, timeouts, sizes, quotas) is listed here with its **trace** (the commit
that introduced or last changed it and the reason given) and an **assessment** of whether that reason still holds.
Audited 2026-10-29 on branch `packs` (about 460 limits).

Assessments: **KEEP** - reason still true. **CHECK** - plausible, never measured. **STALE** - the reason refers to
something that is gone or changed (GPU box, Qdrant, sequential crawl, old models, the pre-packs pipeline).
**NO-TRACE** - no reason recorded anywhere.

**Rule from now on:** a new limit, or a changed value, gets a row here in the same commit - value, where, why
(the evidence: an incident, a measurement, a provider limit). A limit without a reason is removed or measured.
Review STALE/CHECK rows when the thing they depend on changes (a model, a provider, infrastructure).

## Changes made after the audit (2026-10-29)

The tables below show each limit as audited; these rows were then changed:

| Limit | Was | Now | Why |
|---|---|---|---|
| Mixed orders: calculation without our prices | always a quote offer to our own team | the agent asks the network businesses (when the business has a network) | the network was never asked for estimates (chain test: 0 of 20 cases reached the agent; owner's wish 2026-10-26 to reach out to the companies) |
| Simple-calculation shortcut (chat.ts) | Jev "simple" >= 0.4 alone | simple AND Jev "every item priced by our information" >= 0.5 (or no network) | a mixed order (another business's concrete + our rental) passed as simple and never reached the network |
| Order for something this business doesn't offer | answered only (since 2026-10-26) | goes to the agent / network businesses | the form's hand-over that used to do this stopped when the form became "only for what we clearly offer" |
| Order form "offered here" (chat.ts offeredForForm) | one matching item of ours = our form | our items must cover EVERY part (Jev >= 0.5), else the agent / network | "drill rig + core bit", "vinyl floor + primer" opened our form and the rest never reached the network |
| Agent check: totals only from given quantities (sys-agent-given-quantities) | Jev >= 0.5 fails the result (repair round) | agent.ts | C5: scaffolding rates per element x guessed counts = invented total; tested 0.97 bad vs 0.16-0.36 legitimate |
| Agent check: the choice (sys-agent-choice, wybor.json) | - (nothing checked the agent's choice) | code: chosen = cheapest when the criterion is "najtaniej"; each option's amount = its item's recipe (recipeFromFields + evaluate) for the given quantity, difference > 0.01 fails (repair round) | C9 picked the 350 zł trestle over 240 zł; C14/C19 charged hourly where the daily rate was cheaper |
| Chat: our offer items per turn (packsReply) | shops only (catalogue); other businesses' items never reached the chat | every business: matchOfferItems, top 8 (the matcher's ITEM_MIN); none for a specific ask (router specific >= 0.5) = the fact "our price list has no such item"; Jev down = nothing said | C1: paving guides outranked the compactor price list (no price given); C6: "I don't have the mini-excavator price" implied we rent one |
| Chat: prices for the customer's quantities (offer/quantities.ts) | - (the reply model did the arithmetic) | price question (router price >= 0.5) with matched items whose recipe inputs are known: the item matcher's Haiku call also reads the quantities (no separate call), code evaluates the recipes; nothing computed when none given | C14: 30 x 28 = 840 zł instead of 2 days = 280 zł; C19 hourly over daily. |
| Item matcher (search.ts, used by chat, network offerMatches, compare, order forms) | Jev per item name: <=80 direct, else categories (150, >= 0.4) + lexical stems (30); match >= 0.5; network: nearest 30 + lexical 10, Jev batches of 15 | <=80 items direct, else the 40 nearest by vectors (per business, or per item text for merged sets) + the 30 nearest to each part of the split request (up to 4 parts; network calls are one part already), at most 100 items + the whole categories of the 8 nearest (25 items each); one pinned deepseek-v4.1-flash call (temperature 0, seed 7, fp8 providers, 8 s, 400 tokens) returns ids (limit 8, network 15) and on price questions the quantities; the same message + list answered from memory for 1 h (5,000 kept); per-text vector cache 50,000 | 40 hand-labelled messages, 7 businesses: Jev 28/30 found, 25% wrong returned, trestles -> compactors, 23/40 same across runs; deepseek 30/30, 9/10 no-item clean, 21% neighbouring, all quantities right, 0.9 s; Haiku 30/30, 16%, missed quantities and the primer, 2.3 s; bge reranker scores customer sentences ~0. Per-part lists: "vinyl floor 25 m2 and a primer" had no primer in the 40 nearest. Categories: "ubić podjazd" - no plate compactor in the 40 nearest (vectors found only the rammers) |
| Crawl after a 429/503 (crawler.ts) | all workers paused, then 6 at once again with a 1 s delay each | one request at a time across workers, the gap doubled per throttle from 1 s to max 8 s | kwiaciarniamilosc.pl: 6 workers re-throttled together, 25/150 pages in 30 min, the scrape queue blocked behind it |
| Crawl given up on a throttling site (crawler.ts) | - (3 attempts per page, the crawl went on page by page for as long as the job ran) | 12 throttles in a row (no successful fetch between, ~2 min) stop the crawl with the pages read so far | kwiaciarniamilosc.pl kept Render's IP in a penalty window (200 from elsewhere): 7 pages in 10 min, 10 tenants waiting |
| Reply temperature | 0.3 | 0 | 0.3 was tuned on qwen for typos (STALE); 0 = least variation |
| OpenRouter provider choice | sort by throughput (rotating, ~40 deepseek providers incl. fp4) | fixed order per model (src/llm/pin.ts): anthropic / deepinfra fp8 + seed 7 | rotating providers and quantisations = a different model per call; measured: still not repeatable at temperature 0 (Haiku 4/4 different, deepseek 2/4) |
| Need split | a new model call per request | stored per normalised request (R2 decisions/split/) | same request -> same parts for every later step |
| Network judge (find.ts) | Jev >= 0.5 | Jev by default; bge-reranker-v2-m3 >= 0.05 (RERANK_MIN) when NETWORK_JUDGE=rerank | fleet test: reranker 52/57 top-1 vs Jev 50/57, 0 vs 8 flips across repeats; off until the repeated chain cases agree. Plan boost (+0.1/+0.2) is on Jev's scale - re-fit before turning the reranker on |
| Foreign-origin "cheap" mode (serve-multi-tenant.ts) | any request without an allowed Origin, incl. no Origin | only a browser Origin naming another site | server-side integrations and scripts (no Origin) lost the agent and the network |
| Jev calls per turn (jev.ts JEV_TURN_MAX) | 30 (then 100) | 400 | a network question needs ~2 calls per business (31 for 16 businesses; the Warsaw base has 168); 30 switched the fact check off |
| Agent runs per day (chat.ts AGENT_RUNS_*) | 3 per conversation / 6 per IP / 60 per business, counted on every attempt | 10 / 30 / 300, counted only when a run starts | offices and mobile carriers share IPs; never measured; spend caps already bound the cost |
| Messages per recipient per day | SMS 3, WhatsApp 5, Telegram 10, e-mail 6 | 10 / 10 / 20 / 20 | a real request = "result ready" + one offer per business asked (up to 6) - 3 cut real updates |
| MSG_CAP_EXEMPT default | e-mail only in email.ts, nothing in notify-channels.ts | the owner's address in both | inconsistent |
| Signup / onboarding / interview per IP | 5 per hour (one shared counter) | 20 per hour (SIGNUP_PER_HOUR) | one office or a trade fair trying a few sites was locked out |
| Exempt / internal IPs | 79.184.118.71 + 176.9.1.133 hard-coded | QUOTA_EXEMPT_IPS (default 79.184.118.71) everywhere | 176.9.1.133 is the dead GPU box |
| Browserless in health alerts | excluded ("the VPS scrapes") | included | the VPS is gone; onboarding on Render renders JS pages through browserless |
| Admin rescrape-all page cap | 10, max 50 | none (whole site, SCRAPE_MAX_PAGES ceiling) | from the sequential-crawl era; became a real 50-page limit |
| Boot resume of interrupted onboardings | 15 pages (= whole site) | onboarding cap 150 until claimed, whole site after | an unclaimed onboarding resumed at boot skipped the onboarding cap |
| maxTokens passed to the reply model | ignored (every call 1024) | honoured; the calculation notice raised 200 -> 500 | the values were dead code |
| Default reply model (no OPENROUTER_MODEL) | qwen3-235b | anthropic/claude-haiku-5.5 | production model since 2026-10-26 |
| Default embedding host / model / index (no env) | GPU box 176.9.1.133 / bge-large-en-v1.5 / whisp-vectors | Workers AI worker / bge-m3 / whisp-vectors-m3 | the GPU box is gone; English-only default silently mixed embedding spaces |
| Embedding batch size | 256 | 96 | sized for the GPU box; the Workers AI worker takes ~100 |
| Owner answers in the prompt | last 30 (no reason) | all, newest first, up to ~12k chars | older answers dropped silently while the fact check trusted them |
| Router reads the message | first 800 chars (no reason) | 2500 | intent/injection judged on the start of a long inquiry only |
| Input guard message length | 2000 (no reason, initial commit) | 4000 | long pasted inquiries cut silently; the request cap is 32k |
| turnKind (conversation.ts), MUST_ASK_MAX duplicate | dead code / hard-coded 4 | removed / one constant | unused since 2026-10-22 |
| tests/self-hosted.test.ts | tested the GPU box + Qdrant | removed | infrastructure gone |

### Network capability index (src/network/capability-index.ts, added 2026-10-29)

| Limit | Value | Where | Why (trace) |
|---|---|---|---|
| Records per business | 150 (MAX_RECORDS) | capability-index.ts | one business must not fill the 100 nearest records; enough for every page's first chunk on most sites |
| Offer items with their own record | 80 (ITEM_LIMIT); larger offers 60 category records (CATEGORY_LIMIT) | capability-index.ts | kh-bud's items alone filled all 150 and crowded out its page content; a 2,347-product shop summarised by category |
| Nearest records per search | 100 (QUERY_TOP) | capability-index.ts | Vectorize maximum with indexed-only metadata |
| Queries per search for diversity | up to 4, businesses already found excluded ($nin) | capability-index.ts | a 150-record catalogue filled the 100 nearest records - shortlists of 1-2 businesses, chain test 11/2/7 (2026-10-30) |
| Shortlist | 6 per need part (NETWORK_SHORTLIST_PART), one search for chat and agent (src/network/find.ts) | find.ts | measured: Warsaw 10/10 expected businesses in the top 6 (9 at rank 1); fleet of 1,067: 96% in the top 12, 92% top 6 |
| Network wait without a live status line | 10 s (was 3.5 s) | chat.ts packsReply | the one search splits the need into parts first: 3-8 s; API calls without the widget missed the network |
| A priced network offer | a price on one of the 2 best-scored matched items AND Jev >= 0.5 that the item IS the thing asked (not a component / related job / substitute) | find.ts | a loose match (grey laminate for grey vinyl) is not a quote; screed + painting priced a bathroom renovation (C17) |
| Shortlist cache | 60 min (NETWORK_SEARCH_CACHE_MIN) | capability-index.ts | the same need in the same network; records change only at scrape / offer edit |
| Record text | 900 chars (chunk excerpt 500) | capability-index.ts | one idea per record keeps similarity sharp |

Spend caps (budget.ts) stay: $1 per conversation, $10 per business, $80 overall per day. Measured on 2026-10-29:
OpenRouter $3.22 that day (heavy testing), $9.82 that week, $57 that month - $80/day is ~8x the busiest day, a stop
against runaway loops only.

## Still to measure or decide (CHECK / STALE not changed yet)

- Qdrant service + disk in render.yaml - unused since 2026-06-05, still paid; removing it deletes the service (owner's call).
- Fact-check timeout 4000 ms vs 40-60k-char sources; fact-check sources have no total size cap (Jev fails at ~100k chars).
- Top 4 packs at >= 0.5; packs over 9000 chars dropped whole instead of trimmed; any question under 40 chars treated as a follow-up.
- Catalog judge sees the first 1500 chars of a chunk (old retrieval path, used by hasPricesFor / knowledgePassages); hasPricesFor still uses that path, not the packs.
- Offer index: 150 pages x 6000 chars; facts index 4000 sentences; sitemap caps 25 files / 5000 URLs; PDFs over 10 MB skipped.
- Shop catalogue: descriptions cut at 700/1000 chars; one failed Store API page ends the import.
- Temperature 0.3 (its reason was observed on qwen); the nine check thresholds >= 0.6 and the out-of-scope < 0.35 were never measured.
- Header/footer blocks over 1500 chars dropped; the site-info chunk keeps the 3 longest blocks.
- Spend counters and rate limits are per instance (more Render instances multiply every cap).


## Audit tables

### Chat answer path - limits inventory (branch `packs`, HEAD 5f642f5, 2026-10-29)

Scope: src/llm/{chat,packs,router,jev,openrouter-provider,turn-usage}.ts, src/knowledge/facts.ts, src/offer/{search,vectors}.ts, src/ecosystem/*.ts, src/security/{input-guard,history-sig}.ts, public/widget.js (history only).
Traces: `git log -S'<literal>' -- <file>` (oldest = introduced, newest = last change) plus `git log -L` where it mattered.
Prod config: tenant-manager.ts passes no `maxTokens`/`topK`, so the defaults (1024 / 15) apply. The reply model is anthropic/claude-haiku-5.5 (render.yaml).

Assessment key: KEEP = the stated reason still holds. CHECK = plausible but unmeasured, or it now interacts badly with something. STALE = the reason refers to something removed or changed. NO-TRACE = no reason anywhere.

## Pack selection and rendering (packs.ts, chat.ts packsReply)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Topic pack max size | 9000 chars | packs.ts:26,55 | e454c27 2026-10-25 (packs intro). Comment: "Topics small enough to be one pack" - no reason for 9000 | CHECK | When a contact/locations/policies/people topic is over 9000 chars, the topic pack is **dropped entirely**, not trimmed. Multi-branch businesses lose the "all locations/contacts" pack. The render budget is 40k, so 9000 is not forced by anything |
| Candidate packs per turn | 14 (+2 contact/locations topics) | packs.ts:62,87,91 | e454c27 2026-10-25; no reason | CHECK | Any size reason went away when 4d74373 started batching the scoring. With 20 hits it rarely binds, but it is unmeasured |
| "Small site: judge every pack" | <= 18 packs | packs.ts:64 | 4f6eb35 2026-10-25 "all packs for small sites". Comment: search ranked the services page out of a 25-passage site | KEEP | The reason is still true. Cost is bounded by batching |
| Article (blog) candidates | max 4 | packs.ts:72 | a297732 2026-10-25 "at most 4 article candidates". Comment: a blog-heavy site's posts outranked its offer pages | KEEP | Still valid |
| preview() default length | 900 chars | packs.ts:103 | 42435a3 2026-10-25. Superseded by 4d74373 2026-10-26 (scorePacks passes PASSAGE_MAX) | STALE | Dead default: the only caller passes 20000. The comment itself says judging by the first 900-3000 chars caused misses |
| Pack-scoring Jev timeout | 15000 ms (not hedged) | packs.ts:130 | 4d74373 2026-10-26 "Jev scores whole pages, in batches of 80k chars" | CHECK | Needed for 80k batches, but over 6 s there is no hedging. If Jev stalls the visitor waits up to 15 s before the first token. Latency of 80k batches was never measured |
| Jev batch size for pack scoring | 80000 chars | packs.ts:137 | 4d74373 2026-10-26. Comment: "One request takes about 80k characters (more is a 400)" | CHECK | The limit is real (~100k fails), but the counter covers pack texts only. The conversation (up to 8x700 = 5.6k) and per-pack instructions (~450 chars each) come on top, so a batch is ~90k+. The margin to the 400 is thin and unverified |
| Passage hard cut | 20000 chars | packs.ts:154,166 | 4abdc90 2026-10-25 "whole passages in packs (40k budget, cut only > 20k)" | KEEP | Measured in the quality round. Haiku handles it |
| Pack text budget in prompt | 40000 chars | packs.ts:155 | 4abdc90 2026-10-25 (same) | KEEP | Same |
| Stop rendering when left | < 1000 chars | packs.ts:161 | 4abdc90 2026-10-25 | KEEP | Minor |
| Chunk dedupe key | first 160 normalised chars | packs.ts:29 | e454c27. Comment: "the same footer on every page once" | KEEP | Catalog chunks start with a per-chunk summary, so false merges are unlikely |
| Packs search topK | max(topK,20) = 20 | chat.ts:788 | 551105e 2026-10-25 "Vectorize caps topK at 20 with returnMetadata=all, so 30 failed every search on sites with more than 18 pages" | KEEP | Vectorize cap still applies |
| Packs kept: score >= 0.5, top N | 0.5 / 4 | chat.ts:800 | e454c27 2026-10-25; no reason for 4 | NO-TRACE | A comparison or multi-topic question needing 5+ pages loses some, even with budget left (4 whole pages often fit in 40k) |
| Jev-down fallback | top 3 by search order | chat.ts:802 | 4f6eb35 2026-10-25 "Jev-down fallback". Comment: search's best pages instead of "no information" | KEEP | Valid |
| Follow-up query trigger | router followup >= 0.5 **or question < 40 chars** | chat.ts:778 | 4f6eb35 2026-10-25 "follow-up queries + last packs" | CHECK | The 40-char length rule sits on top of Jev's followup signal. Every short **new** question ("a parking macie?") gets the previous question + reply mixed into its search query and keeps last turn's packs as candidates. It is the brittle-heuristic kind and unmeasured |
| Previous reply in follow-up query | first 200 chars | chat.ts:779 | 4f6eb35 2026-10-25; comment: "what our last reply was about" | CHECK | The value is unmeasured. The first 200 chars of a reply are often the preamble, not the subject |
| Conversation given to Jev (scoring, full/ours, all checks) | last 8 messages x 700 chars | chat.ts:758 | e454c27 2026-10-25; no reason | NO-TRACE | The input guard allows 2000-char messages, so a long customer message is judged only on its first 700 chars. The "unanswered" check cannot see later parts, and pack scoring misses them |
| Conversation language kept unless | >= 12 letters | chat.ts:770 | 4f6eb35. Comment: a name, phone or "ok" doesn't switch it | KEEP | Valid |
| No-catalog fallback gate | 12 hits x 1500 chars, >= 0.5 | chat.ts:806-807 | e454c27, carried from 2297dee 2026-09-27 "scores each retrieved passage (full text, up to 12)" | CHECK | Only tenants without a catalog. 1500-char judging is the partial-judging problem 4d74373 fixed for packs |
| full/ours check input | 40000 chars | chat.ts:832 | 4abdc90 2026-10-25 | CHECK | passages = facts + pack passages (up to 40k) + **product lines appended last**. With full packs the shop products are cut off, so "full" is judged without them |
| full/ours Jev timeout | 5000 ms | chat.ts:835 | 4abdc90 2026-10-25; no reason | NO-TRACE | On timeout it defaults to full=1/ours=1 (fails open to "answered", no partial / no network) |
| Partial answer threshold | full < 0.5 | chat.ts:837 | 6fa9be3 2026-10-25 "relevant but incomplete -> what we know + missing detail + hand-off offer" | KEEP | Midpoint, the stated behaviour holds |
| Out-of-scope -> network | ours < 0.35 | chat.ts:838 | 4abdc90 2026-10-25 "out-of-scope needs go to the network"; no measurement for 0.35 | NO-TRACE | Unmeasured. It decides whether a related-but-not-ours page blocks the network |

## Turn routing, forms, calculations (chat.ts packsStream, router.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Router input slices | prevUser 600 / prevReply 1200 / message 800 chars | router.ts:46 | 311f4cd 2026-10-22 "one Jev router"; no reason | NO-TRACE | message is cut at 800 though the guard allows 2000. Intent, injection, lang and "specific/need" are judged on the first 800 chars (an injection after char 800 is invisible) |
| Flow description in router | 400 chars | router.ts:69 | 311f4cd | KEEP | Descriptions are short |
| Router Jev timeout | 5000 ms (hedged) | router.ts:72 | 311f4cd 2026-10-22 | KEEP | A null route switches off network/hand-off, so a generous timeout is right |
| Flow ambiguity window | p >= 0.3 and within 0.25 of top | router.ts:84, jev.ts:143 | 2297dee 2026-09-27 / 311f4cd; no measurement | NO-TRACE | Unmeasured |
| Router memo | 60 s TTL, cleared at 300 entries | chat.ts:1120,1123 | 311f4cd "one decision per message" | KEEP | Valid |
| Route memo key | last 300 chars of prev reply | chat.ts:1119 | 311f4cd | KEEP | Valid |
| Injection block | rt.injection >= 0.8 (JEV_INJECTION_MIN) | chat.ts:700 | 140449b 2026-10-29 "injection detection in any language (Jev, in the router call)"; no value reason | NO-TRACE | A false positive answers the whole turn as "blocked". Unmeasured on real traffic |
| Hand-off offer TTL | 30 min | chat.ts:657 | e454c27 2026-10-25 | KEEP | Same as the form idle TTL |
| Hand-off answer must be | choice prob >= 0.7 | chat.ts:668 | 4f6eb35 "explicit consent". Comment: only an explicit yes starts the form | KEEP | Valid |
| Our offer text given to Jev | last 600 chars | chat.ts:659 | 96aa7d4 2026-10-25 "judged against what we wrote" | KEEP | Valid |
| Form context from conversation | last 5 msgs x 400 chars | chat.ts:678 | 4f6eb35. Comment: the form starts from the conversation | KEEP | Valid |
| Mid-form question detection | noul >= 0.75, 3000 ms | chat.ts:688-689 | 4f6eb35 "mid-form questions"; no reason for 0.75 | NO-TRACE | Unmeasured |
| Flow ambiguity shown / stored | 2 / 3 | chat.ts:708,713 | 311f4cd, 4f6eb35, 369a40a | STALE | `picked.slice(0,3)` is a no-op: picked is already <= 2 |
| Calculation needs figures | digits in last 3 user msgs | chat.ts:730 | 4abdc90 "calculations need figures" | KEEP | Valid |
| Pure calc | price < 0.5 or ownPrices >= 0.5 | chat.ts:731 | 4f6eb35 "customer prices = pure calc" | KEEP | Valid |
| Simple-calc in chat | noul >= 0.4; convo 6 x 500; 3000 ms | chat.ts:737-739 | 983daae 2026-10-26 "two listed items scored 0.58-0.65, a full bathroom renovation 0.12" | KEEP | Measured |
| Agent quotas per day | 3 / session, 6 / IP, 60 / tenant | chat.ts:1155-1157 | 140449b 2026-10-29 (code comment) | KEEP | Spend control |
| Language Jev (agent notices) | 3000 ms | chat.ts:1166,1275 | NO TRACE | KEEP | Falls back to en/pl. Harmless |
| Form idle | 30 min | chat.ts:296 | e872c2b 2026-10-23 | KEEP | Valid |
| Pending "which flow" | 5 min | chat.ts:500 | 07ba040 2026-07-20 | KEEP | Benign |
| sessionVia | 500 entries / 30 min | chat.ts:1197 | 12d6c51 2026-09-30 | KEEP | Memory |
| packStates | 3000 sessions (FIFO) | chat.ts:639 | e454c27 | KEEP | Memory (OOM history) |
| offeredForForm | topK 6, lexical 4, 10 passages x 1500 | chat.ts:1220-1222 | 4d74373 2026-10-26 "an order form starts only for what is clearly offered" | KEEP | Values not traced, but the behaviour holds |
| collectKnowledge | 5 offer items + 5 lexical snippets | chat.ts:1207-1208 | d2fe877 2026-10-02 | KEEP | Form checks only |

## Prompt and reply generation

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Site pages listed in prompt (and in fact-check sources) | first 20 of siteMap | chat.ts:869,1382 | e454c27 / 92d1c9f 2026-10-25; no reason for 20 | NO-TRACE | Sitemap order, not relevance. On sites with >20 pages the model can't see the relevant page to link to |
| Owner answers in prompt | last 30 contextNotes | chat.ts:871 | 369a40a 2026-10-25; no reason | NO-TRACE | Older owner answers silently drop out of the prompt, while verifySources (chat.ts:1388) still gets **all** of them. An owner who filled many gaps loses the oldest answers |
| Reply length rule | "at most about 80 words" | chat.ts:890 | 92d1c9f 2026-10-25 "answers capped at ~80 words unless a full list is asked" | KEEP | Valid |
| Reply max_tokens | 1024 | chat.ts:351; openrouter-provider.ts:76 | 91107d5 2026-05-03 "Add OpenRouter (DeepSeek V3)"; no reason. REASONING comment: Haiku spent 170-230 of max_tokens on reasoning | CHECK | Fine for 80 words. A "full price list" reply in Polish can hit 1024 and stop mid-list. The value was chosen for DeepSeek V3 |
| maxTokens args 200 / 512 / 700 | ignored | chat.ts:475,1187,1235,1287 | 6dc45bd 2026-09-29 (700), e454c27 (200) | STALE | `OpenRouterBackend.generate()/generateStream()` (chat.ts:164-180) drop the maxTokens argument, so the provider always uses 1024. Only `classify()` honours it |
| Reply temperature | 0.3 | openrouter-provider.ts:77-78 | 4abdc90 2026-10-25. Comment: "at 0.7 the replies had typos, garbled words and small invented details" | STALE | Observed on qwen3-235b (Haiku became the reply model 2026-10-26). Probably still fine, but the reason is qwen-specific and Haiku at other temperatures was never measured |
| Fallback reply model | qwen/qwen3-235b-a22b-2507 | openrouter-provider.ts:75; tenant-manager.ts:176 | a3736c2 2026-09-30 | STALE | Not numeric. Used only if OPENROUTER_MODEL is lost (the blueprint-sync gotcha), and it would silently revert to the losing model |
| Network: quick wait for matches | 400 ms (widget shows status) / 3500 ms | chat.ts:844 | 83e03b5 2026-10-27 "the owner's wish 2026-10-27, like Gemini's search" | KEEP | Owner decision |
| Network: continuation wait | 12000 ms | chat.ts:923 | 83e03b5 2026-10-27 | CHECK | askEcosystem = embed + Vectorize per member (25 in parallel) + Jev 5 s. Large ecosystems or Jev stalls can exceed 12 s, and the reply then says "none found" although matches arrive |
| Network passage in prompt | 900 chars each | chat.ts:1080 | e454c27 | KEEP | Matches the Jev excerpt length |
| Network evidence: need | 300 chars | chat.ts:1083 | e454c27 | KEEP | Valid |
| Network ask condition | specific >= 0.5 and need >= 0.5 and followup < 0.5 | chat.ts:1305 | 5c349b6 2026-10-22 "need signal - the 10-year guarantee went to the network" | KEEP | Valid |
| Hand-off re-offer gap | >= 2 turns | chat.ts:854,859,926 | 4f6eb35 (comment) | KEEP | Valid |
| Record offer if | offers >= 0.5 | chat.ts:962 | 4f6eb35 | KEEP | Valid |
| Gap question stored | 200 chars | chat.ts:967 | 61a72f1 2026-09-27 | KEEP | Dashboard label |
| Shop products: nearest / lexical / pool | 40 / 25 / 70 | chat.ts:1061-1065 | e994ee1 2026-10-29 | KEEP | A pool of 70 is under DIRECT_MAX 80, so it is judged in one Jev call |
| Shop products shown | 6 (live search 10) | chat.ts:1067,1071-1072 | e994ee1 2026-10-29; no reason | NO-TRACE | Unmeasured. "All your X" questions see 6 items at most |

## Reply checks and rewrites

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Fact-check question | last 2 user messages | chat.ts:976 | 4f6eb35 | KEEP | Valid |
| Fact-check sources per item | 20000 chars | chat.ts:976 | 4abdc90 2026-10-25 "fact check sees whole passages" | KEEP | Valid |
| verifySources items | 600 | chat.ts:1391 | fdcd39e 2026-10-26, 'whole' variant (fact check against the whole site). That variant was removed in bdf0299 | STALE | Harmless now (about 50 passages or fewer), but it refers to the removed variant. There is **no total size cap**: up to 40k of passages + facts + products + network evidence + all owner notes + 20 pages + 2x1500 earlier replies can approach Jev's ~100k failure. A failure means the fact check is unavailable, and the reply is rewritten to contact-only |
| verifySources maxLen default | 2500 | chat.ts:1381 | 4f6eb35 | STALE | The only caller passes 20000 |
| Earlier replies in sources | last 2 x 1500 chars | chat.ts:1383 | 92d1c9f 2026-10-25 "our earlier replies in the conversation" | KEEP | Valid |
| Fact-check Jev timeout | 4000 ms | jev.ts:208 (default since fdcd39e; the 4000 dates from 94c1d94 2026-09-27, "~0.3-0.4 s per check") | CHECK | Measured on small chunk-based sources. Sources are now ~40-60k chars, and since 140449b the check **fails closed**: a timeout rewrites the reply to contact-only |
| Unsupported-statement threshold | >= 0.6 (JEV_VERIFY_MIN) | chat.ts:997 | 94c1d94 2026-09-27: bad statements 0.84/0.91, correct ones max 0.29 | KEEP | Judge-side and independent of the reply model (only 2 cases, though) |
| Statements checked | length >= 12, max 24 | jev.ts:199-200 | 94c1d94 2026-09-27 | KEEP | 80-word replies have about 5-8 statements. Long full lists beyond 24 go unchecked |
| Behaviour checks Jev timeout | 4000 ms | chat.ts:987 | 4abdc90; no reason | NO-TRACE | On timeout every check reads 0 (fails open) |
| 9 behaviour-check thresholds (offers, denies, contradicts, promises, meta, unanswered, claimsSent, vouches, callUs) | >= 0.6 each | chat.ts:999-1009 | e454c27 / 4f6eb35 / 96aa7d4 2026-10-25; no measurement | NO-TRACE | None calibrated. A false positive costs a rewrite (latency), a false negative ships the problem |
| Rewrite rounds | 2 | chat.ts:1024 | 4f6eb35 "checks re-run on every rewrite" | KEEP | Valid |
| Draft quoted in correction | 2500 chars | chat.ts:1027 | 4f6eb35 | KEEP | Over 80-word replies |

## Legacy retrieval still in use (not by the packs reply itself)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| WebsiteChat topK default | 15 | chat.ts:352 | b586e82 2026-05-29 "Fix pricing retrieval: topK 15 + keyword boost" (Qdrant / bge-large-en era) | STALE | The packs path overrides it to 20. 15 survives only in retrieveContext |
| retrieveContext boosts | pricing topK 5, identity topK 5, language topK/2 = 7, dedupe by first 50 chars, catalog hits 25 | chat.ts:525-595 | b586e82 2026-05-29; 0a32dfb 2026-07-20; fd042c0 2026-05-11 "search stripped keywords when language mismatches"; c03b14f 2026-09-27 | STALE | Built for the old pipeline and English-only BGE (bge-m3 has been multilingual since 2026-09-27). Still feeds hasPricesFor and knowledgePassages |
| hasPricesFor | 12 chunks x 1500, max >= 0.5; offer match limit 3 | chat.ts:1132-1140 | 311f4cd 2026-10-22 | STALE | It decides "no prices, so offer a quote" from the old retrieval (above) and the 0.005 filter, not from the packs the reply would get. It can contradict the answer path on calculation questions |
| filterContextChunks score floor | > 0.005 | chat.ts:1329 | 771ba14 2026-05-05 "lower score threshold for RRF hybrid search (0.5 -> 0.005)" | STALE | RRF was Qdrant hybridSearch. CloudflareVectorizeStore has no hybridSearch (cosine), so this is a no-op |
| knowledgePassages | 10 | chat.ts:1102 | 7bcebd1 2026-10-13 | CHECK | The project agent / network get site knowledge through the legacy retrieval |

## Jev client and providers

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Jev per-turn call cap | 100 (JEV_TURN_MAX) | jev.ts:49 | 5f642f5 2026-10-29 "a network question needs one judgement per business (31 calls for 16 businesses) - the cap of 30 turned off the fact check on network questions" | CHECK | The reason holds, but the need **scales with network size** (~2 calls per business), so a ~50-business network crosses 100 again. Hitting the cap now fails the fact check closed (contact-only reply). It should scale or exempt the fact check |
| Jev default timeout | 2500 ms | jev.ts:51 | 2297dee 2026-09-27 | KEEP | Used by jevPassageRelevance / jevPickOption |
| Hedge schedule | 300 / 800 / 1600 / 3000 ms | jev.ts:52 | 919acb5 2026-09-28 "against bimodal latency" (measured) | KEEP | Measured |
| Hedge only for budgets | 2000-6000 ms | jev.ts:77 | 140449b 2026-10-29 "backups only for quick calls" | KEEP | Valid (but see the 15 s pack scoring above) |
| Business excerpt / timeout | 900 chars / 5000 ms | jev.ts:167,174 | 1fa6e37 2026-09-30 | KEEP | Valid |
| Jev health window | 5 min, 2000 entries; 402 -> 10 min; >= 5 calls and > 50% failed | jev.ts:238-244 | 140449b 2026-10-29 "health/credit alert" | KEEP | Valid |
| OpenRouter retries | 2 | openrouter-provider.ts:38 | 0f79d99 2026-10-22 | KEEP | Valid |
| Failed provider avoided | 10 min | openrouter-provider.ts:12 | e497b56 2026-10-22. Comment: Vertex answered 404 for hours | KEEP | Haiku is also served via Vertex |
| Avoid list max | 2 | openrouter-provider.ts:23 | 80f943a 2026-10-23. Comment: skipping all leaves nowhere to run | KEEP | Valid |
| Slow provider rule | first token > 5 s, or < 300 tok in > 8 s -> skip 5 min | openrouter-provider.ts:27-30 | 80f943a 2026-10-23 "Venice 15.7 s for 80 tokens" (a qwen provider) | CHECK | Tuned on a qwen provider. Haiku with 40-60k-char prompts plus rewrites may approach a 5 s first token and bench a good provider |
| OpenRouter timeouts | 60 s / 120 s stream | openrouter-provider.ts:88,134 | c9d2ef2 2026-10-10 | KEEP | Valid |

## Key facts (only in the A/B variant 'facts': chat.ts:785)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Sentences per index | 4000 | facts.ts:12 | 3b0d1b0 2026-10-27. Comment: ostap.pl PDFs took 3561 of 4000 | KEEP | Variant only |
| Sentence length | >= 12, cut at 400; title 80 | facts.ts:27-33 | 3b0d1b0 | KEEP | Valid |
| Nearest / from PDFs | 25 / max 5 | facts.ts:103-106 | 3b0d1b0 "7/7 missed facts in the top 25"; a1c4a6f "manuals crowded out the homepage line" | KEEP | Measured |
| Kept by Jev | >= 0.5, max 8, 5000 ms | facts.ts:91,111-113 | 3b0d1b0 | KEEP | 8 not traced. Harmless |
| Index memory | 120 MB LRU | facts.ts:68 | 3b0d1b0 | KEEP | OOM history |

## Offer items (search.ts, vectors.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Items per Jev call | 80 (DIRECT_MAX) | search.ts:9 | d2fe877 2026-10-02. Comment: up to this many judged in one Jev call | KEEP | Valid  REPLACED 2026-10-30 by the Haiku item matcher (see changes) |
| Categories judged / kept | 150 / >= 0.4 | search.ts:47,50 | c9d2ef2 2026-10-10 / d2fe877; no reason | NO-TRACE | 0.4 is unmeasured, and categories past 150 are never considered  REPLACED 2026-10-30 by the Haiku item matcher (see changes) |
| Lexical items / stem | 30 / 5-letter stems | search.ts:53-58 | c9d2ef2. Comment: Polish inflection ("ubijaka" ~ "Ubijak") | KEEP | Valid  REPLACED 2026-10-30 by the Haiku item matcher (see changes) |
| Item match | >= 0.5, limit 8, 6000 ms | search.ts:10,19,36 | d2fe877 2026-10-02 | KEEP | Valid  REPLACED 2026-10-30 by the Haiku item matcher (see changes) |
| Item text / query | 160 / 2000 chars | vectors.ts:12,52 | 3421ac1 2026-10-18 | KEEP | Valid |
| Embed batch | 96 | vectors.ts:26 | 3421ac1 2026-10-18; no reason | NO-TRACE | Probably a Workers AI batch ceiling, but undocumented |

## Ecosystem / network (ecosystem/*.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Candidates judged | 8 | ask.ts:34 | 1fa6e37 2026-09-30 "ranked top-3 with one Jev call" | KEEP | Fixed cost per question |
| Businesses relayed | 3 | ask.ts:35; rank.ts:33 | f65fa5b 2026-09-29 / 1fa6e37 | KEEP | Product decision |
| Passages per business | 3 | ask.ts:36 | 1fa6e37 | KEEP | Valid |
| Vector floor | 0.3 | ask.ts:37 | 1fa6e37 2026-09-30. Comment: below this nothing of theirs is about the question | CHECK | Set 3 days after the bge-m3 switch and never measured. m3 cosine between unrelated texts is often 0.3-0.45, so the floor likely filters nothing and the 8 are picked by rank alone |
| Vectorize parallelism | 25 | ask.ts:38 | 1fa6e37 | KEEP | Valid |
| Profile | 2 sections, 700 chars | ask.ts:50-51 | 6040b09 2026-09-30 | KEEP | Valid |
| Contact cache | 10 min | ask.ts:71 | 1fa6e37 | KEEP | Valid |
| Min question | 3 chars | ask.ts:95 | 93b62eb 2026-09-29 | KEEP | Valid |
| Qualify / plan boost | offers >= 0.5; pro +0.1, premium +0.2 | rank.ts:16,33 | 1fa6e37 | KEEP | Business rule |
| Hand-off link | TTL 24 h; last 8 turns x 1500; need 2000; label 120 | handoff.ts:25,46-51 | 4156289 2026-09-30 | KEEP | Valid |

## Input, history, widget

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Message max length (truncate) | 2000 chars | input-guard.ts:17,79-80 | e542682 2026-05-03 (initial commit); no reason | NO-TRACE | Silently cuts a pasted long inquiry or spec (last message only). Downstream also cuts it at 800 (router) and 700 (Jev conversation) |
| Obfuscation warnings | base64 >= 50, special chars > 40% (ASCII class) | input-guard.ts:85,100 | e542682 | KEEP | Warnings only, no effect on the answer (Polish diacritics count as "special") |
| Regex block | injection regex and < 10 chars left | input-guard.ts:141 | e542682 | KEEP | English-only, but Jev injection now covers other languages |
| History verification | D1 LIMIT 60 replies; prefix >= 20 chars; sig 32 chars | history-sig.ts:16,33,36 | 140449b 2026-10-29 | KEEP | The widget sends at most 40 messages (about 20 assistant) |
| Posted history trim | last 40 msgs, <= 30000 chars | widget.js:1079-1080 | d6c2040 2026-06-03 "stay under the new /api/chat caps" (<= 50 msgs, <= 32768; still at serve-multi-tenant.ts:1253,1258) | KEEP | Caps still exist |
| Persisted chat | last 20 msgs | widget.js:200 | e542682 2026-05-03; no reason | NO-TRACE | After a reload only 20 messages return. Harmless (packs use the last 8) |

## Counts

KEEP 76, CHECK 14, STALE 11, NO-TRACE 17 (119 rows; some rows group several related numbers).

### Scrape / knowledge / embedding limits - inventory (branch `packs`, 2026-10-29)

Repo: /Users/kubal/Desktop/projects/website-context-packs. Traces from `git log -L <line>,<line>:<file>` (newest touching commit first) and `git log -S`. "e542682" = the initial import commit (2026-05-03, no reasoning) - counted as NO-TRACE unless a later commit or code comment gives a reason.

Assessments: KEEP = the reason still holds; CHECK = plausible but unverified / may lose knowledge; STALE = the reason points at something gone or changed; NO-TRACE = no recorded reason.

## Crawl (src/scraper/crawler.ts, fetcher.ts, safe-url.ts, decode.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Default maxPages | 500 | src/scraper/crawler.ts:9 | 61a72f1 2026-09-27 "ceiling SCRAPE_MAX_PAGES (500) instead of the callers' 15/20 caps" (was 100 by c2fdd41 06-01, 40 by bce8220) | KEEP | Matches the pipeline's hard ceiling; the parallel crawl is built around it |
| maxDepth | 10 | crawler.ts:10, scrape-pipeline.ts:76 | 61a72f1 2026-09-27 "6 pages in parallel, depth 10" | KEEP | Sitemap URLs enter at depth 1, so depth rarely binds; protects against link chains |
| rateLimit (delay after each page, per worker) | 100 ms | crawler.ts:12, scrape-pipeline.ts:76 | 61a72f1 / e542682 - no reason given | NO-TRACE | Harmless politeness delay; with 6 workers that is about 60 req/s at most |
| concurrency | 6 (SCRAPE_CONCURRENCY) | crawler.ts:14,40; scrape-pipeline.ts:76 | 61a72f1 2026-09-27 "6 pages in parallel... 92 pages in 13s" | KEEP | Measured. Rendered pages are capped separately (MAX_DYNAMIC) |
| Per-page fetch timeout | 15000 ms | crawler.ts:28, fetcher.ts:21 | e542682 2026-05-03, never revisited | NO-TRACE | A slow page (>15s) fails, with no retry except on 429/503; Polish shared hosting can be slow |
| Triage batch | 60 URLs per Jev call | crawler.ts:68 | 643b33c 2026-10-29 "smaller batches: each address gets attention" | KEEP | Recent and measured on empro.pro |
| Triage switch-on | >= 300 sitemap URLs (TRIAGE_MIN_URLS), or a catalogue shop | crawler.ts:104 | 643b33c 2026-10-29 "on when the sitemap declares 300+ URLs or the shop has a catalogue (small sites crawl as before)" | KEEP | Recent. Own page/post sitemap URLs bypass triage (d1eeebd) |
| Triage keep threshold | noul >= 0.3; Jev failure = read everything | src/scraper/triage.ts:20 | 643b33c 2026-10-29, comment "leaning to read: a missed page costs more than a wasted fetch" | KEEP | Fails open toward reading pages |
| Triage Jev timeout | 20000 ms | triage.ts:18 | 643b33c 2026-10-29 | KEEP | A timeout returns null, so the batch is read without triage |
| Triage leftovers at the page cap | "N left unjudged" are never read | crawler.ts:217,250 | 643b33c 2026-10-29 | CHECK | When maxPages (150 before claim, 500 after) is reached, pending candidates are dropped silently. Only logged, never put in the audit |
| Throttle back-off | Retry-After or 5 s x attempt, max 60 s | crawler.ts:144 | d304341 2026-09-27 "crawler backs off on 429/503" | KEEP | Standard politeness |
| Post-throttle delay | politeDelay >= 1000 ms for the rest of the run | crawler.ts:146 | d304341 2026-09-27 | KEEP | Avoids repeat bans. Slows a 500-page crawl to about 6 pages/s |
| Throttle retries | 3 attempts per page | crawler.ts:147 | d304341 2026-09-27 | KEEP | After that the page counts as a failure |
| Link text kept for triage | 80 chars | crawler.ts:211 | 643b33c 2026-10-29 | KEEP | Only feeds the triage judgement |
| Crawler trap rule | path repeating a word segment (>=3 chars, non-numeric) is skipped | crawler.ts:83-84 | bb37b73 2026-10-29 "empro.pro onboarding timed out after 30 min... relative links nesting forever" | KEEP | Only exact repeated segments are skipped, so legitimate paths are rarely hit |
| Content-hash dedup floor | text < 200 chars is never deduped | crawler.ts:279 | 61a72f1 2026-09-27 "content-hash dedup", comment "too thin to call two pages identical" | CHECK | The hash uses extractor.ts blocks (h/p/ul/table in the FIRST main selector, without the 30% guard markdown.ts gained in b64e14d). Two pages that differ only in div text (Elementor) can hash equal, and the second page is skipped as [DUP] |
| MAX_SITEMAPS | 25 sitemap files | crawler.ts:283 | 61a72f1 2026-09-27 (sitemap-first discovery); no reason for 25 | CHECK | Shops split products into many sitemap files (product-sitemap1..N). Index order decides which 25 are read, so page-sitemap.xml can fall outside and lose its "own pages bypass triage" status |
| MAX_SITEMAP_URLS | 5000 URLs | crawler.ts:284 | 61a72f1 2026-09-27; no reason for 5000 | CHECK | Truncated in declaration order. With triage plus catalogue skipping, a larger cap is cheap; pages past 5000 are found only through links |
| Sitemap fetch timeout | 10000 ms | crawler.ts:296 | 61a72f1 2026-09-27; 6908041 2026-10-29 moved it to safeFetch (SSRF) | KEEP | Bounded discovery |
| robots.txt timeout | 5000 ms | crawler.ts:317 | e542682 2026-05-03 | NO-TRACE | Fails open (no robots means everything is allowed); harmless |
| Static-fetch skip codes | 404/410/429/503 never re-rendered | fetcher.ts:29 | d304341 2026-09-27 comment "never re-hit the site with a browser... 403 still gets the browser" | KEEP | Reasoned |
| Redirect hops | 8 | fetcher.ts:61, safe-url.ts:41 | 6908041 2026-10-29 "Security... each hop checked to be on the public internet" | KEEP | SSRF guard; 8 hops is generous |
| browserless connect timeout | 20000 ms (then local Chromium) | fetcher.ts:110 | e8a6c24 2026-07-16 "migrate browserless v1 -> v2, local-Chromium fallback" | KEEP | Has a fallback |
| MAX_DYNAMIC (rendered pages at once) | 2 | fetcher.ts:135 | 61a72f1 2026-09-27 "rendered pages capped at 2 at once"; comment "memory-heavy" | KEEP | Render memory; an all-SPA site crawls at 2x speed, not 6x |
| Render settle wait | 2000 ms after domcontentloaded | fetcher.ts:181 | 9112779 2026-05-07 "Changed waitUntil to domcontentloaded (networkidle hangs on cloud)"; 2 s is from e542682 | CHECK | Slow SPAs (Wix, React shops) can still be an empty shell after 2 s. The thin page is kept as is, with no re-wait |
| SPA-shell detection | body text < 50 and body < 200 chars, or page text < 50 | fetcher.ts:229,243 | e542682 2026-05-03 | NO-TRACE | A page with a cookie banner / nav of 50+ chars but JS-only content passes as "static" and is never rendered. This loses knowledge on SPAs |
| Charset sniff window | first 4096 bytes | src/scraper/decode.ts:10 | 5cefcc0 2026-10-25 "windows-1250 / ISO-8859-2 sites lost every Polish letter" | KEEP | A meta charset sits in the head |

## PDF, markdown, extractor

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| MAX_PDF_BYTES | 10 MB | src/scraper/pdf.ts:14 | 85c805d 2026-07-19 "extract PDF text into the knowledge base (unpdf)"; no reason for 10 MB | CHECK | Product catalogues / price-list PDFs above 10 MB are skipped whole, logged only as "skipped (too large...)" |
| MAX_PDF_TEXT | 60000 chars | pdf.ts:15 | 85c805d 2026-07-19 | CHECK | Cut silently after about 20-30 pages of text; the rest of a long price list / manual is lost |
| PDF BLOCK_TARGET | 1500 chars | pdf.ts:18 | 85c805d 2026-07-19, comment "so the downstream chunker (and the BGE input window) never sees one giant block" | STALE | The value is fine, but the "BGE input window" reason was bge-large-en (512 tokens). bge-m3 on Workers AI takes about 8k tokens per text |
| PDF cut rule | sentence cut must be >= 50% of the target | pdf.ts:25 | 85c805d 2026-07-19 | KEEP | Formatting of blocks |
| PDF download timeout | 2 x page timeout = 30 s | pdf.ts:40 | 85c805d 2026-07-19 | KEEP | PDFs are bigger |
| Scanned-PDF floor | < 200 chars of text = skipped | pdf.ts:55 | 85c805d 2026-07-19 "Scanned/image-only PDFs... skipped - indexing noise is worse than a gap" | KEEP | Deliberate; the owner can upload a photo (extract-image) |
| Main-area share | main selector must hold >= 30% of body text | src/scraper/markdown.ts:88 | b64e14d 2026-10-25 "Elementor pages whose first widget is empty converted to nothing - 19% of sampled tenants" | KEEP | Measured fix |
| Section fallback | >= 2 `<section>` -> whole body | markdown.ts:97 | 5af5bfb 2026-05-06 "extract ALL visible text" | KEEP | Errs toward more text |
| Item-card fallback | div text < 200 chars or has a price | markdown.ts:204 | 5af5bfb 2026-05-06 | STALE | `extractItemContent` is no longer called anywhere (dead code since the recursive walker) |
| filterForLLM min | section < 5 chars dropped; link-heavy > 50% of words (>10 words) dropped | markdown.ts:376,389 | 5af5bfb 2026-05-06, comment "Lowered from 20 to 5: short menu items"; link ratio from e542682 | KEEP | Only feeds `fitMarkdown` -> page contentHash (store.ts:127), not chunks |
| Extractor paragraph floor | `<p>` <= 10 chars dropped | src/scraper/extractor.ts:119 | e542682 2026-05-03 | NO-TRACE | Affects page.content (crawl dedup hash, site map), not chunks (chunks come from markdown.ts) |
| Link text | 200 chars | extractor.ts:192 | e542682 2026-05-03 | KEEP | Link labels only |

## Large-shop catalogue (src/scraper/catalogue.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| MIN_PRODUCTS | 150 (CATALOGUE_MIN_PRODUCTS) | catalogue.ts:18 | e994ee1 2026-10-29 "Below MIN_PRODUCTS the shop is small enough for the normal crawl" | KEEP | Recent and reasoned |
| MAX_PRODUCTS | 10000 (CATALOGUE_MAX_PRODUCTS) | catalogue.ts:19 | e994ee1 2026-10-29 | KEEP | The offer store caps at 12000; live shop search goes beyond |
| Store-API timeout / pagination | 20000 ms, no retry; one failed page ends pagination | catalogue.ts:27,63,78 | e994ee1 2026-10-29 | CHECK | One timeout or 5xx on page N `break`s the loop, so every product after it is silently missing (their pages are skipped from the crawl too, via the prefix rule) |
| Woo pages | per_page 100, <= ceil(MAX/100) pages | catalogue.ts:57-59 | e994ee1 2026-10-29 | KEEP | API maximum is 100 |
| Shopify pages | limit 250, <= 60 pages | catalogue.ts:71-75 | e994ee1 2026-10-29 | KEEP | 60 x 250 = 15000 > MAX |
| Product description | Woo short+long desc 700 chars, whole field 1000; Shopify body 700/1000 | catalogue.ts:43,47,89 | e994ee1 2026-10-29; no reason for 700 | CHECK | These product pages are NOT crawled, so the 700-char excerpt is ALL the bot knows about a product. Specs, dimensions and compatibility past 700 chars are lost |
| Product-sitemap discovery | 45 s, <= 60 sitemap files, 8 s each | catalogue.ts:102-108 | e994ee1 2026-10-29 "a slow or blocking sitemap must not hold the onboarding up (mrowka.com.pl: 10 min)" | KEEP | Measured |
| JSON-LD harvest deadline | 20 min (CATALOGUE_SITEMAP_MIN) | catalogue.ts:126 | e994ee1 2026-10-29 | KEEP | Under the 90-min job limit |
| JSON-LD sample | first 12 URLs, >= 8 must carry Product data, 45 s | catalogue.ts:129-137 | e994ee1 2026-10-29 "pages without product data (most sites) are left to the normal crawl at once" | KEEP | Reasoned |
| JSON-LD fetch | 8 parallel, 15 s each, first Product per page | catalogue.ts:139-146 | e994ee1 2026-10-29 | KEEP | Variants on one page are collapsed to one item (slice(0,1)), which is worth checking |
| Catalogue accept | items >= min(150, 50% of URLs) | catalogue.ts:149 | e994ee1 2026-10-29 | KEEP | Reasoned |
| Product prefix rule | first path segment shared by >= 60% of product URLs -> every page under it skipped | catalogue.ts:162-164 | e994ee1 2026-10-29 "every product page under it is left to the catalogue, also ones the API does not list" | CHECK | If products live under a segment that also holds non-product pages (/sklep/regulamin, /shop/dostawa), those pages are skipped from the crawl |

## Pipeline + worker (src/multi-tenant/scrape-pipeline.ts, background-worker.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| SCRAPE_MAX_PAGES ceiling | 500 | scrape-pipeline.ts:62 | 140449b 2026-10-29 "Anti-abuse... a client-sent maxPages of 1e6 meant an unbounded crawl"; 61a72f1 2026-09-27 | KEEP | Hard ceiling, reasoned |
| "Small cap = whole site" rule | maxPages < 50 means the ceiling; >= 50 is a real cap | scrape-pipeline.ts:63 | 140449b 2026-10-29, comment "Old small caps (<50) still mean whole site" | KEEP | Keeps legacy callers working |
| ONBOARD_MAX_PAGES | 150 until claimed | scripts/serve-multi-tenant.ts:1037,1823 | 140449b 2026-10-29 "until the owner sets a password the crawl stops at ONBOARD_MAX_PAGES" | KEEP | Anti-abuse. Re-scrape on claim is assumed, so worth checking that it happens |
| Google Maps scrape budget | 30000 ms | scrape-pipeline.ts:114, google-places.ts:24 | db3ad8c 2026-05-28 "Add 30s timeout to Google Maps scrape - was hanging forever"; 554737f 06-01 watchdog | KEEP | Supplement only |
| Maps reviews / hours | 15 reviews, 7 hour rows, 5 categories | google-places.ts:129-131 | 2786faa 2026-09-28 "working extraction through the remote browser" | KEEP | Supplementary data |
| Embed failure tolerance | <= 10% of chunks may fail | scrape-pipeline.ts:172 | a2fcbba 2026-06-01 "partial-embed-fatal... (the old `< min(3,N)` gate let a 200-chunk site pass with only 3 embedded)" | KEEP | Reasoned |
| Vector verify poll | 12 attempts, 2 s x n up to 12 s (~100 s), never fatal | scrape-pipeline.ts:190,197 | c6c8eea 2026-06-03 "don't fail scrape on Vectorize insert lag" | KEEP | Reasoned |
| Catalog namer output | maxTokens 600 | scrape-pipeline.ts:279 | c03b14f 2026-09-27 | KEEP | Up to 5 short catalog names |
| Offer LLM default output | maxTokens 3000 (extract.ts passes 6000) | scrape-pipeline.ts:306-307 | 63981da 2026-10-10 | KEEP | The only caller (extractFromBlock) overrides it with 6000 |
| Worker job retries | 3 attempts | background-worker.ts:13 | 9acdf5d 2026-05-06 "3 retries with exponential backoff (5s, 15s, 30s)" | KEEP | The backoff described is gone (a 10 s cooldown only), but 3 still makes sense |
| Job timeout | 90 min (SCRAPE_JOB_TIMEOUT_MIN) | background-worker.ts:19 | 1e21b5c 2026-10-29 "scrape job limit 90 min (empro.pro: 2943 chunks... timed out at 30)" | KEEP | Measured. The comment above it still says "6 min, not 3" (stale text, not a stale value) |
| Cooldown between jobs | 10 s | background-worker.ts:20 | 3c9e9c5 2026-05-06 "Prevents OOM crashes on 512MB Render instances during bulk scrapes" | CHECK | Set when pages were held in memory and a local Chromium ran; streaming conversion (be05479) and browserless changed that. Cheap, but the 512 MB reason is unverified now |
| enqueue default maxPages | 20 | background-worker.ts:60,80 | 6ff72bc 2026-05-05 (sequential-crawl era) | STALE | A sequential-crawl cap. Ignored now (<50 = whole site), but it misleads readers |
| Boot re-enqueue maxPages | 15 | background-worker.ts:157 | 717c8fe 2026-05-27 / 59b9701 2026-07-16 | STALE | Same 15/20 sequential cap. It also means a boot-resumed UNCLAIMED onboarding gets the 500 ceiling, not ONBOARD_MAX_PAGES 150 |
| MAX_INTERRUPTS | 3 | background-worker.ts:133 | bcb44e7 2026-09-28 "count interrupted scrapes in D1, give up after 3" | KEEP | Stops crash loops |
| MAX_BOOT_ENQUEUE | 25 | background-worker.ts:154 | 59b9701 2026-07-16, comment "every completion emails the stored address, so a mass drain must never happen implicitly" | KEEP | Reasoned |

## Chunking + labelling (src/context/store.ts, business-profile.ts, profile-verify.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| tel:/mailto: per page | 3 phones, 3 e-mails | src/context/store.ts:39 | cda4052 2026-06-01 "Capture phone/email from tel:/mailto: links into a reliable Contact chunk" | CHECK | Multi-branch firms list more than 3 numbers per page; the extra ones miss the Contact chunk (the business profile keeps up to 6 alternates) |
| Header/footer block size | 20..1500 chars, else dropped | store.ts:60 | bce8220 2026-06-01 "markdown extraction strips header/footer, discarding address, opening hours" | CHECK | A mega-footer (branch list, all hours) over 1500 chars is dropped WHOLE. That is exactly the data the rule exists to capture |
| buildContext refetch timeout | 10000 ms | store.ts:91 | 61a72f1 2026-09-27 (HTML now reused from the crawl) | KEEP | Rarely used |
| Contact pages for official info | 2 pages x 2500 chars | store.ts:101 | 4d74373 2026-10-26 "official info keeps the site's own contact text" | KEEP | Reasoned |
| Availability lines | 6..240 chars, <= 12 lines | store.ts:106 | 4d74373 2026-10-26 | KEEP | Reasoned |
| Site-info chunk | top 3 header/footer blocks by length, 2500 chars | store.ts:184-185 | bce8220 2026-06-01; be05479 2026-09-28 (streaming) | CHECK | A 4th block (top bar with a phone) or text past 2500 is lost from the chunk |
| Official contactText | 5000 chars | store.ts:207 | 07b6b21 2026-10-25 / 4d74373 2026-10-26 | KEEP | Profile input only |
| slimForProfile fallback | 200000 chars | store.ts:248 | be05479 2026-09-28 | KEEP | Error path only |
| Heading-only section | content < 5 chars -> carried as prefix | store.ts:299 | aba4689 2026-05-06 "prepend parent heading"; b64e14d 2026-10-25 "consecutive empty headings kept" | KEEP | Measured fix |
| Section floor | < 10 chars skipped | store.ts:310 | 77d992c 2026-05-06 / e542682 (no body) | NO-TRACE | Content includes "## heading", so it rarely bites |
| Small-section merge | < 200 chars merged into siblings while total < 3000 | store.ts:318,321 | 77d992c 2026-05-06 "Merge small sibling chunks" (no reason for the numbers) | NO-TRACE | Plausible; set in the bge-large-en era |
| Chunk floor | < 15 chars dropped | store.ts:355 | 77d992c 2026-05-06 / e542682 | NO-TRACE | Drops tiny "Tel: 123" style sections; the Contact chunk covers phones |
| Chunk size | section <= 4000 kept whole, else split at 2500 with 150 overlap; lists/tables never split (unbounded) | store.ts:362, 395-430 | 77d992c 2026-05-06 raised 3000->4000 and 2000->2500 "avoid splitting lists/tables"; 037d643 2026-05-29 | CHECK | Sized when embeddings were bge-large-en (512 tokens, about 1.5-2k chars, the rest truncated); never re-tuned for bge-m3. Unbounded tables can exceed the 5000-char Vectorize metadata copy |
| Labeller outline | 40 headings per page | store.ts:502 | 330127c 2026-09-27 "each call gets the page's title, URL and heading outline" | KEEP | Context only |
| Labeller output | maxTokens 800, temp 0.2 | store.ts:507 | 330127c 2026-09-27 "max_tokens 800 and a 25-word summary cap fix the truncated-JSON failures" | KEEP | Measured |
| Labeller concurrency | 48 (ENRICH_CONCURRENCY) | store.ts:510 | 330127c 2026-09-27 "48 in parallel" | KEEP | Measured, 77/77 labelled |
| Labeller floor | chunk < 60 chars not labelled | store.ts:517 | 330127c 2026-09-27 ("3 too short") | KEEP | Left unlabelled, not dropped |
| Labeller retries / timeout | 4 attempts, 45 s each, backoff 2^n s | store.ts:541-542 | 330127c 2026-09-27 "48 in parallel, 45s timeout, up to 4 attempts with backoff" | KEEP | Measured. The model is OPENROUTER_MODEL (haiku-5.5) unless ENRICH_MODEL is set |
| Labeller input | chunk text 6000 chars | store.ts:574 | 330127c / 037d643 | KEEP | Covers the 4000-char chunk |
| Label keywords | max 15, min 3 else no label | store.ts:613,615 | abbcb84 2026-09-27 "never invent a summary" | KEEP | Reasoned |
| Phone digit range | 7..14 digits (prose), 7..15 (tel:) | src/context/business-profile.ts:107,152 | 3bd5c2e 2026-06-03 "Harden contact extractor" | KEEP | E.164 range |
| Alternate phones/e-mails | 6 | business-profile.ts:196-246 | 4204071 2026-06-02 / 3bd5c2e 2026-06-03 | KEEP | Profile display |
| Profile verify Jev picks | choice >= 0.6; structured value dropped if < 0.3 | src/context/profile-verify.ts:102,133,164 | 07b6b21 2026-10-25 "stale structured data dropped... Jev picks" | KEEP | Reasoned |
| Profile verify pages | first 4 (contact-ish first), 12000 chars; Jev page_text 6000 / 4000 | profile-verify.ts:108,121,122,162 | 07b6b21 2026-10-25 | KEEP | Contact pages are sorted first |

## Embeddings + vector store (src/embeddings/*.ts, workers/bge-embed)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| BGE host default | 176.9.1.133:7900 | src/embeddings/bge-provider.ts:17-18 | 233746a 2026-07-16 "Workers AI BGE shim + BGE_URL cutover (GPU box gone)" (the default was kept) | STALE | The dead GPU box. Only BGE_URL in render.yaml saves prod; a local or script run without it hangs or 30 s-times out |
| Default embed model | bge-large-en-v1.5 when EMBED_MODEL unset | bge-provider.ts:35 (and vectorize-store.ts:13 index default whisp-vectors) | 9a3f749 2026-09-27 "bge-m3 (inert until switched on)" | STALE | Prod has been on bge-m3 / whisp-vectors-m3 since 09-27. A missing env var silently embeds in English-only space into the old index |
| Provider batch | 256 texts per HTTP call | bge-provider.ts:31 | e542682 2026-05-03 (self-hosted GPU server) | STALE | Sized for the GPU box. Matters for buildFactIndex: up to 4000 sentences = 16 sequential calls with no retry, and one failure loses the whole fact index |
| BGE HTTP timeout | 30000 ms | bge-provider.ts:51 | cafd934 2026-05-11 "BGE timeout: 30s fetch timeout prevents hanging" | CHECK | Set for the GPU box. A 256-text bge-m3 call fans out to 3+ sequential Workers AI runs inside the worker, which can be tight |
| Pipeline batch | 50 chunks per embed call | src/embeddings/pipeline.ts:17 | e542682 2026-05-03 | NO-TRACE | Works (about 50 x 1.6k tokens < 50k worker budget) |
| Embed retries | 3 attempts, 2 s x attempt, then split in halves | pipeline.ts:22,48,52-56 | cafd934 2026-05-11 "3 attempts per batch"; 1e21b5c 2026-10-29 "a batch that keeps failing is split so only the bad chunk is lost" | KEEP | Measured |
| EMBED_CONCURRENCY | 4 lanes | pipeline.ts:73 | 1e21b5c 2026-10-29 "one at a time took ~20 min for a 3k-chunk shop" | KEEP | Measured |
| Worker token budget | 50k est. tokens per AI call (2.5 chars/token), <= 100 texts, 60000 chars/text, halve on 3030 | workers/bge-embed/src/index.ts | (worker file) comment "Workers AI caps a whole bge-m3 request at 60k tokens" | KEEP | Current bge-m3 constraint, documented |
| Vectorize metadata budget | 9800 bytes per vector | src/embeddings/vectorize-store.ts:25 | 270f70c 2026-07-19 "Vectorize rejects >10KiB of COMPACT-JSON metadata (40016)... all 44 chunks failed" | KEEP | Platform limit |
| Upsert batch | 1000 vectors | vectorize-store.ts:77 | 292c1d5 2026-05-28 "Vectorize max batch is 1000" | KEEP | Platform limit |
| Metadata content copy | content 5000 chars, title 300, url 500, headings 500 | vectorize-store.ts:87-91 | 292c1d5 2026-05-28 (Vectorize replaces Qdrant); 270f70c 2026-07-19 | CHECK | Wherever chat reads chunk text from Vectorize metadata (not R2 context/catalog), long table chunks are cut at 5000 chars / 9.8 KB |
| get_by_ids batch | 20 ids | vectorize-store.ts:196 | 13c119b 2026-06-12 "Vectorize per-request id cap, error 40007" | KEEP | Platform limit |
| deleteAll drain | 25 rounds x 250 passes, 15 s settle, 12 verify probes | vectorize-store.ts:281-306 | 06971c6 2026-05-29 "random-probe round-based drain (handles async deletes)" | KEEP | Vectorize semantics (async deletes) unchanged |
| Probe vector dimension | 1024 | vectorize-store.ts:118,259 | 292c1d5 / 06971c6 2026-05 | KEEP | bge-m3 is also 1024-d |
| Qdrant default host | 152.53.243.28:6333 | src/embeddings/qdrant-store.ts:18 | e542682 2026-05-03; superseded by 292c1d5 2026-05-28 "Cloudflare Vectorize integration - replaces Qdrant" | STALE | Only src/index.ts (the old library entry) uses it; the multi-tenant pipeline is Vectorize-only |
| OpenAI provider batch | 100 | src/embeddings/openai-provider.ts:17 | e542682 2026-05-03 | STALE | Unused in prod (BGE only) |

## Knowledge catalog, facts, audit, file/image KB (src/knowledge/*.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Catalog growth rounds | 3 | src/knowledge/catalog.ts:63 | c03b14f 2026-09-27 "Jev-sorted, self-growing index" | KEEP | Leftovers go to "Inne", not lost |
| MAX_CATALOGS | 40 | catalog.ts:64 | c03b14f 2026-09-27 | KEEP | Bounded Jev criteria |
| Classify / score batches | 8 / 10 chunks per Jev call, 6 parallel | catalog.ts:65-67 | c03b14f 2026-09-27 | KEEP | Throughput |
| CHUNK_CHARS (what Jev sees of a chunk) | 1500 chars | catalog.ts:68, used at :106 (classify) and :389 (answer scoring) | c03b14f 2026-09-27; no reason given | CHECK | Chunks run to 4000 chars plus a ~300-char label, so Jev judges relevance on the first ~1200 chars of body. A fact in the second half of a long price list / FAQ chunk is invisible to the scorer, the chunk scores low and is not used. This is the most likely retrieval-side knowledge loss |
| Namer sample | 40 unassigned chunks x 600 chars | catalog.ts:143 | c03b14f 2026-09-27 | KEEP | Only names catalogs |
| Lexical candidates | k = 15 | catalog.ts:227 | 657ea88 2026-09-27 "Jev judges vector and BM25 hits alongside catalog candidates" | KEEP | Adds candidates |
| Title scan | 60 per batch, 10 parallel, keep >= 0.3, top 40, only KBs <= 1500 chunks (TITLE_SCAN_MAX) | catalog.ts:272-276 | 94c1d94 2026-09-27 "select by chunk titles" (comment: "bigger KBs pre-select by catalog (latency)") | CHECK | Set before full-site crawls produced 3k-chunk KBs (empro.pro 2943). Those skip the per-chunk title scan and fall back to catalog picks (max 3 catalogs / 80 chunks) |
| Catalog pick | >= 0.35, max 3 catalogs, 80 scored chunks, answer minScore 0.5 | catalog.ts:306,313,314,325 | c03b14f 2026-09-27; 61a72f1 "Jev scores the 80 most promising chunks" | CHECK | On big KBs only 80 chunks (vector hits first, then word overlap) reach the Jev judge |
| MAX_SENTENCES (key facts) | 4000 | src/knowledge/facts.ts:12 | 3b0d1b0 2026-10-27; a1c4a6f "PDFs last... ostap.pl 3561 of 4000" | CHECK | A 500-page site has more than 4000 sentences. Order is own pages, then blog, then PDF, but within own pages it follows catalog chunk order, so late pages' sentences are dropped silently |
| Fact sentence | >= 12 chars, cut at 400; title 80 | facts.ts:27-33 | 3b0d1b0 2026-10-27 | KEEP | Reasoned |
| Facts LRU | 120 MB | facts.ts:68 | 3b0d1b0 2026-10-27 "kept in a small in-memory LRU" | KEEP | Memory guard |
| Facts per answer | 25 nearest (max 5 from PDFs), Jev >= 0.5, max 8 | facts.ts:91,105-113 | a1c4a6f 2026-10-27 "at most 5 of the 25 nearest" | KEEP | Measured (7/7 missed facts in top 25) |
| Audit parallelism | 3 questions at a time, 1 retry | src/knowledge/audit.ts:62,78 | 57a8ef5 2026-10-26 "questions three at a time with one retry" | KEEP | Reasoned |
| Audit "pages missing" | > 25% of pages with no text | audit.ts:45 | 5fc833c 2026-10-26 | KEEP | Reporting only |
| Uploaded file text | 200000 chars, blocks of 1500 | src/knowledge/extract-file.ts:8-9 | 21572f1 2026-07-20 "upload documents (PDF/XLSX/CSV/DOCX/TXT)" | KEEP | Big XLSX price lists past 200k chars are cut, which is worth knowing |
| Image text blocks | 1200 chars; vision max_tokens 1800 | src/knowledge/extract-image.ts:46,62 | 440b6fc 2026-07-22 "extract text from photos" | KEEP | One photo rarely exceeds it |

## Offer index (src/offer/index-scrape.ts, extract.ts, store.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Offer MAX_PAGES | 150 pages read by the LLM | src/offer/index-scrape.ts:18 | 63981da 2026-10-10 "Offer index... built while scraping" (comment "pages an LLM reads per site") | CHECK | Set 2 weeks AFTER the 500-page crawl. On sites with more than 150 offer pages (non-catalogue), pages past 150 in crawl order are never read, and items there never reach the offer index |
| PAGE_TEXT | 6000 chars per page | index-scrape.ts:19; extract.ts:50 | 63981da 2026-10-10 / d2fe877 2026-10-02 | CHECK | A long price-list page is cut at 6000 chars, so items past that are lost (chunks still have them, but structured prices do not) |
| Boilerplate filter | block on >= 40% of pages (min 3) removed; sites < 4 pages exempt | index-scrape.ts:115-117 | 63981da 2026-10-10 "menus/sidebars repeated across pages removed" | KEEP | Reasoned |
| Page floor | < 80 chars of text skipped | index-scrape.ts:118 | 63981da 2026-10-10 | KEEP | Nothing to extract |
| Business types | noul >= 0.6 from the first page's 3000 chars | index-scrape.ts:133-134 | 63981da 2026-10-10 | KEEP | Falls back to "other" |
| Offer-page filter | 25 pages per Jev call, 4 parallel, keep >= 0.4 (Jev down = keep all) | index-scrape.ts:141-147 | 63981da 2026-10-10 | KEEP | Fails open |
| Field verification | Jev noul < 0.5 -> field unknown; page_text 5000 | index-scrape.ts:161-167 | 63981da 2026-10-10 "Jev verifies each filled field against the page" | KEEP | Reasoned (no guessing) |
| Dedupe | compare with the last 60 kept items, same if >= 0.7 | index-scrape.ts:181-186 | 63981da 2026-10-10 "Jev merges duplicates" | KEEP | One Jev call per item, sequential, so it is slow on big offers but correct |
| Extraction parallelism | 8 pages, 4 field checks each | index-scrape.ts:208-211 | 63981da 2026-10-10 | KEEP | Throughput |
| Extract LLM output | maxTokens 6000 | src/offer/extract.ts:64 | 63981da 2026-10-10 | KEEP | Covers a 6000-char page |
| File extract batch | 5000 chars per LLM call, 4 parallel | extract.ts:86-90 | d2fe877 2026-10-02 | KEEP | Owner uploads |
| Offer MAX_ITEMS | 12000 | src/offer/store.ts:39 | e994ee1 2026-10-29 "a shop catalogue can be large; beyond it the chat searches the shop live" | KEEP | Above the catalogue's 10000 |
| Offer cache | 5 min | store.ts:48 | d2fe877 2026-10-02 | KEEP | Read cache only |
| Item field caps | name 200, description 1000, category 100, 20 components | store.ts:107-140 | d2fe877 2026-10-02 | KEEP | Schema hygiene; the catalogue path already cut descriptions to 700/1000 |

## Storage (src/storage/*.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| CF auth refresh | at most every 60 s | src/storage/cf-auth.ts:40 | (not traced; auth plumbing) | KEEP | No effect on knowledge |
| D1 timeout | 15000 ms (D1_TIMEOUT_MS), one 800 ms retry | src/storage/conversation-store.ts:21,30 | (conversation log, not KB) | KEEP | Out of the scrape path |
| R2 upload / download | no size or batch caps in r2.ts | src/storage/r2.ts | - | KEEP | None found |

### Limits inventory - project agent, network, leads, invites, reviews, customer updates, flows, form agent

Repo: website-context-packs (branch packs), HEAD 5f642f5, 2026-10-29. Traces come from `git blame` / `git log -S`.
Rows marked **[GATE]** decide whether a chat turn reaches the project agent or the network at all. They live in src/llm/chat.ts, src/llm/router.ts, src/security/* and scripts/serve-multi-tenant.ts, which are outside the listed folders, but they are the gates.

## A. Gates: chat -> project agent / network (check these first)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| **[GATE]** Foreign origin -> `cheap` turn (no network search, no agent) | `foreign && !exempt`. Foreign = no admin header and Origin not the tenant's domain/siteUrl/whisp.so/localhost/*.onrender.com/allowedOrigins | scripts/serve-multi-tenant.ts:1311, 1365; originAllowed :1220 | 140449b 2026-10-29 "foreign-origin widgets get no costly extras"; 88f239f 2026-10-29 added `!exempt` | CHECK (top suspect) | A script or eval harness that sends no Origin and no X-Admin-Secret is "foreign", so every turn is cheap: networkStart is skipped (chat.ts:782) and agentTurn returns null (chat.ts:1152). Every case gets answered in chat, which matches the symptom exactly. Shipped today. |
| **[GATE]** QUOTA_EXEMPT_IPS default | "79.184.118.71,176.9.1.133" | serve-multi-tenant.ts:1305 | 88f239f 2026-10-29 (the IPs date back to the internal-IP analytics filter, 94d73cf 2026-05-28) | STALE (partly) | The exemption only skips quotas and spend caps. It does NOT stop a turn being "foreign" unless the request also has a demo pass or admin header. 176.9.1.133 comes from the May era (GPU-box time, box gone 2026-07). The current VPS and test IPs are probably not listed. |
| **[GATE]** SPEND_SESSION_USD | $1.00 per conversation per day | src/security/budget.ts:14 | 140449b 2026-10-29 "a scripted conversation can't run up a bill" | CHECK | Over the cap the turn is cheap: no agent, no network. A long multi-case eval run in one session can cross $1 (network turns make ~31 Jev calls). |
| **[GATE]** SPEND_TENANT_DAY_USD | $10 per business per day | budget.ts:15 | 140449b 2026-10-29 | CHECK (suspect on test days) | Agent runs are also charged to the initiating tenant (agent.ts:451, up to maxCostUsd 0.5 each). A heavy test day on one pilot tenant can put the whole business on "cheap" until UTC midnight, so all its turns get answered in chat. |
| SPEND_GLOBAL_DAY_USD | $80 per day; alert at 80% | budget.ts:16, :40 | 140449b 2026-10-29 | KEEP | A hard stop. It gives a 503, not a silent fallback. |
| **[GATE]** AGENT_RUNS_SESSION | 3 per conversation per day | src/llm/chat.ts:1155 | 140449b 2026-10-29 "project agent quotas per conversation/IP/business" | CHECK | The count is bumped before the project exists and before the IP/tenant checks, so a failed attempt still uses one. The 4th calculation in a conversation is answered from pages (null). |
| **[GATE]** AGENT_RUNS_IP | 6 per visitor IP per day | chat.ts:1156 | 140449b 2026-10-29 | CHECK (top suspect for a batch test) | A live test of more than 6 cases from one non-exempt IP sends every later case to chat (logged as `agent_quota` / noteTurn agentLimit=quota). Counts live in D1 (usage_quota), so they persist across deploys. |
| **[GATE]** AGENT_RUNS_TENANT | 60 per business per day | chat.ts:1157 | 140449b 2026-10-29 | CHECK | Fine for production. A pilot test day can reach it. |
| **[GATE]** Agent only for `intent === "calculate"` (plus a form hand-over) | router choice | chat.ts:728; router.ts INTENTS | 311f4cd 2026-10-22 (router); 369a40a 2026-10-25 removed the old pipeline | CHECK (suspect) | A mixed order phrased as an order ("I'll take 20 bags of X and 10 m2 of Y from ...") routes to `order`. That path reaches the agent only through the order-form hand-over, which is now effectively unreachable (next rows). |
| **[GATE]** Order form only when the whole request is clearly offered | offeredHere strict: offered >= 0.5 -> ok, otherwise "elsewhere" | chat.ts:711 + src/flows/collect.ts:197 | 4d74373 2026-10-26 "'not clearly not offered' started a form for paving at a renovation firm (offered 0.02, unknown 0.57)" | CHECK (top suspect) | Before this, a form started unless NOTHING was offered (notOfferedHere), and the form's first turn handed the order to the agent and network (collect.ts:343). Now a mixed order (part ours, part another business's) is never "clearly offered", so no form starts, so no hand-over, so packsReply answers it. That kills the main route for mixed orders. |
| **[GATE]** Collect first-turn hand-over | only if `offerItems.length && agentEnabled && hasNetwork` and `transcript.length <= 1` and the item is not_seen/not_offered | chat.ts:1238; collect.ts:343 | fcf2124 2026-10-19 "Routing and network fixes from the full-chain test" | STALE | It was designed for when forms started on "not clearly not offered". Since 4d74373 it fires only if the whole request is clearly offered yet a select field's item is not, which is rare. A business without priced offer items never hands over. |
| **[GATE]** Simple-calculation gate (answered in chat) | Jev noul >= 0.4: "at most three unit prices (listed by the business or given by the customer) x quantities" | chat.ts:738-739 | 6851f7c 2026-10-26 "Simple calculations from listed prices answered in chat ... the rest still goes to the calculation"; 983daae 2026-10-26 "threshold 0.4 (two listed items scored 0.58-0.65, a full bathroom renovation 0.12)"; 4fb072b 2026-10-26 extended it to pure/quantity-only requests | CHECK (top suspect) | It was calibrated on one business's own listed items. The question doesn't exclude prices that belong to OTHER businesses, so a mixed order of 2-3 items from several suppliers easily scores >= 0.4 and gets answered in chat. That means no broadcast, no requests to businesses, no lead or invite. 0.4 is low (below the 0.5 used everywhere else). |
| **[GATE]** hasPricesFor | own priced items (findOfferItems limit 3, ITEM_MIN 0.5) or network priced items, else site passages (top 12, relevance >= 0.5) | chat.ts:1130-1140 | 311f4cd 2026-10-22 "one Jev router in the owner's priority order" | CHECK (suspect) | When false, the turn gets BEHAVIOUR.quote. Because `behaviour` is then non-empty, networkStart is also skipped (chat.ts:782). So a mixed order whose prices exist only at network businesses outside networkOffers() gets no agent AND no network, just a quote offer. |
| `figures` check | regex `/\d/` over the last 3 user messages | chat.ts:730 | 4abdc90 2026-10-25 "A calculation needs figures; 'how much for a bathroom?' is a quote question" | CHECK | A regex gate, which goes against the no-brittle-patches rule. Quantities written as words ("dwa worki", "a dozen") skip the agent. |
| `pure` (pureCalc) | `(price < 0.5 or ownPrices >= 0.5) and figures` | chat.ts:731 | 4f6eb35 2026-10-25 "customer prices = pure calc" | CHECK (suspect) | pureCalc turns the network broadcast off completely (agent.ts:276) and tells the agent "don't ask other businesses". An order-phrased mixed request ("I need 20 bags + 5 m3") can score price < 0.5 and lose the network. |
| networkStart (ecosystem relay) | intent elsewhere, or specific >= 0.5 and need >= 0.5 and followup < 0.5; only when no behaviour preset and not cheap | chat.ts:1305, :782 | 5c349b6 2026-10-22 "network asked only for a product or service another business could provide"; `specific` wording 311f4cd 2026-10-22 | CHECK (suspect) | The `specific` question asks for "ONE specific, concrete product", so a multi-part mixed order can score < 0.5 and the network relay is skipped. The quote/simpleCalc paths also skip it. |
| JEV_TURN_MAX | 100 Jev calls per turn | src/llm/jev.ts:49 | 5f642f5 2026-10-29 "30 -> 100: a network question needs one judgement per business (31 calls for 16 businesses)" | KEEP | Just fixed. Over the cap, the simple gate reads 0 and the turn goes to the agent, so it doesn't block. Watch it as the network grows (scales with business count). |
| JEV_INJECTION_MIN | 0.8 | chat.ts:700 | 140449b 2026-10-29 "injection detection in any language" | KEEP | It blocks only manipulation attempts. |
| DIRECT_MAX (offer search pool) | 80 items per Jev call, else category + lexical pooling (30) | src/offer/search.ts:9 | d2fe877 2026-10-02 "Offer creator" | CHECK | hasPricesFor flattens ALL network businesses' priced items into one list. Above 80 it falls back to category picking, which can miss the item, so hasPricesFor returns false and you get the quote path with no agent and no network.  REPLACED 2026-10-30 by the Haiku item matcher (see changes) |
| ITEM_MIN | 0.5 | search.ts:10 | d2fe877 2026-10-02 | KEEP | The standard threshold.  REPLACED 2026-10-30 by the Haiku item matcher (see changes) |
| Hand-off offer window / yes | 30 min; choice prob >= 0.7 | chat.ts:657, 668 | e454c27 / 4f6eb35 2026-10-25 "explicit consent" | KEEP | Owner decision: only an explicit yes. |
| Mid-form question | noul >= 0.75 | chat.ts:689 | 4f6eb35 2026-10-25 | KEEP | Current packs path. |
| COLLECT_IDLE_MS | 30 min | chat.ts:296 | e872c2b 2026-10-23 "drops a form idle 30 min" | KEEP | |
| Router memo | 60 s, cleared above 300 entries | chat.ts:1121-1123 | 311f4cd 2026-10-22 | KEEP | One decision per message. |
| Router flowAmbiguous | p >= 0.3 and within 0.25 of the top | router.ts:93 | 4f6eb35 2026-10-25 | KEEP | |

## B. Project agent (src/projects/agent.ts, plan.ts, owner-chat.ts, repo.ts, store.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Run budget: maxSteps / timeoutSec / maxCostUsd | 60 / 900 s / $0.50 | agent.ts:374 | 4ea2f63 2026-10-12 (cost); d7f32c8 2026-10-13 last changed; models benchmarked 2026-10-12: "~$0.01/task" | CHECK | Still fits DeepSeek V4.1 Flash (render.yaml). $0.50 is 50x a typical run, and runs now count toward SPEND_TENANT_DAY_USD $10, so about 20 worst-case runs make a business cheap. |
| MAX_RUN_MS (poll deadline) | 20 min | agent.ts:39 | 4ea2f63 2026-10-12 | KEEP | timeoutSec 900 plus a collect margin. Status also finishes a run lazily. |
| POLL_MS | 10 s | agent.ts:37 | 4ea2f63 2026-10-12 | KEEP | |
| MAX_INPUT_FILE | 512 KB | agent.ts:40 (used :353, :805) | 4ea2f63 2026-10-12 | KEEP | Bigger files are not given to the agent. |
| Runner HTTP timeouts | 180 s default; warm 120 s; GET status 60 s; DELETE 30 s | agent.ts:63, 334, 413, 454 | 4ea2f63 2026-10-12; warm c5e12f8 2026-10-16 "startup ~107 s -> ~36 s" | KEEP | |
| "collecting" grace | 120 s | agent.ts:412 | 4ea2f63 2026-10-12 | KEEP | |
| prepareInputs cache | 10 min per need hash | agent.ts:261 | 3421ac1 2026-10-18 "planner and run share it" | KEEP | |
| Catalog cap | 3000 entries returned, 1500 cached | agent.ts:211 vs :325 | 7bcebd1 2026-10-13 / 3421ac1 2026-10-18 | CHECK | Inconsistent: the first call returns 3000 but a cache hit (planner then run) returns the 1500 version. The run sees a smaller allow-catalog than the planner. |
| mustAsk cap | `.slice(0, 4)` hard-coded | agent.ts:303 | 331eab9 2026-10-19 "every business answers, Jev picks the best offers per part" | CHECK | Duplicates the unused MUST_ASK_MAX (network.ts:71). With more than 4 parts lacking a price, the extra businesses are never asked. |
| Arithmetic tolerance | 0.011 per expression; totals match 0.005 | agent.ts:625, 777 | bb4e53d 2026-10-16 "arithmetic"; 4ea2f63 2026-10-12 | KEEP | |
| Verification Jev thresholds | language >= 0.5; customer-only < 0.5; no-promise < 0.5; spec items >= 0.5 | agent.ts:741, 772, 774, 790 | 4ea2f63 2026-10-12; 5c3fa75 2026-10-13; 311f4cd 2026-10-22; d7f32c8 2026-10-13 | KEEP | |
| Spec check input | 4000 chars per file, 14000 total; Jev 10 s | agent.ts:783-786 | d7f32c8 2026-10-13 | CHECK | Long tables get cut, so a spec item can read as unmet or open on large outputs. |
| Verification Jev timeouts | 8000 ms (language, customer-only, lang detect) | agent.ts:739, 770, 819 | 4ea2f63 2026-10-12 | KEEP | |
| MODELS price table | DeepSeek V4.1 Flash 0.15/0.6, MiMo 0.14/0.28 (USD per Mtok, 2026-10-12) | agent.ts:27-32 | 4ea2f63 2026-10-12 benchmark "97/100" | KEEP | Still the render.yaml models. |
| Planner caps | MAX_FACTS 15, MAX_INPUTS 20, MAX_OUTPUTS 8, MAX_ACCEPT 8; text 300/600/1200 | plan.ts:33, 91-111 | d7f32c8 2026-10-13 "frozen spec" | KEEP | |
| PLANNER_TIMEOUT_MS | 90 s; one retry after 3 s | plan.ts:125, 229 | e0f9e11 2026-10-13 "hardened from live runs" | KEEP | |
| Request text cap | 3000 chars | plan.ts:174 | d7f32c8 2026-10-13 | KEEP | |
| Owner chat | MAX_TURNS 12, MAX_TOOL_ROUNDS 4, FILE_LIMIT 6000, LLM 60 s, draft 20000 | owner-chat.ts:20-22, 66, 108 | d7f32c8 2026-10-13 | KEEP | |
| Project event read | LIMIT 500 | store.ts:175 | 63981da 2026-10-10 | CHECK | A long project (network rounds, polls) can pass 500 events. The status page and history lose the latest events (ORDER BY id ascending). |
| Stored-text caps | events 20000; titles 120-200; consent 2000; evidence 1000; requirement text 500 | store.ts:70, 92, 142; repo.ts:49-116 | 63981da 2026-10-10 / bf3727a 2026-10-12 | KEEP | Storage hygiene only. |
| Conversation transcript to agent | last 20 messages | conversation.ts:96 | 1064061 2026-10-12 | KEEP | |

## C. Conversation projects and customer updates (conversation.ts, notify-channels.ts, routes.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Conversation project TTL | 30 days | conversation.ts:17 | 1064061 2026-10-12 "Every conversation is a project" | KEEP | Matches retention (db2b0ba: expired projects idle 30 days). |
| Known-project memo | cleared above 20000 | conversation.ts:36 | 1064061 2026-10-12 | KEEP | |
| turnKind memo / threshold | 60 s; choice >= 0.6; < 8 chars -> other | conversation.ts:64-81 | 1064061 2026-10-12; last caller removed 311f4cd 2026-10-22 | STALE | turnKind has no callers since the router (2026-10-22). It's dead code from the old estimate/work pipeline. |
| Busy window | run running/collecting < 20 min, or pending < 4 min | conversation.ts:165-166, 408 | 1064061 2026-10-12 | KEEP | A new message during a run gets "busy". It matches MAX_RUN_MS. |
| Business-question filter | noul >= 0.5 (default 1), conversation 3000 chars, Jev 8 s | conversation.ts:345-346 | 5c3fa75 2026-10-13 "Questions for the business go to the owner first" | KEEP | |
| Notice wording | maxTokens 160 | conversation.ts:481 | 2e77402 2026-10-26 | KEEP | |
| Telegram/WhatsApp send timeout | 15 s | notify-channels.ts:51, 58 | 2e77402 2026-10-26 "status page ... notified" | KEEP | |
| Per-recipient SMS/WhatsApp/Telegram/e-mail caps | (in src/security/quota.ts) | - | 140449b 2026-10-29 | CHECK | Outside the listed files. Not traced value by value. |
| Status-page customer file read | < 200 KB | routes.ts:145 | 5c3fa75 2026-10-13 | KEEP | |
| Owner-edited customer file | <= 500000 chars | routes.ts:207 | 5c3fa75 2026-10-13 | KEEP | |
| Review answers | 500 / 2000 chars | routes.ts:194 | 5c3fa75 2026-10-13 | KEEP | |
| Sweep interval (leads + late reviews) | 10 min | routes.ts:328 | 236c022 2026-10-22 | KEEP | |

## D. Network: requests between businesses (network.ts, broadcast.ts, compare.ts)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| MAX_REQUESTS | 6 businesses per project; raw entries read 18 | network.ts:23, 149, 172 | 7bcebd1 2026-10-13 "Businesses of a network work together" | CHECK | Applies only AFTER an agent run (askBusinesses), so it doesn't stop requests reaching the agent. Only the first round is asked (networkAsked). |
| NETWORK_ANSWER_DEADLINE_MS | 24 h | network.ts:24, 295 | 7bcebd1 2026-10-13 | CHECK | Checked only when the customer's chat or status polls (conversation.ts:417). It equals LEAD_EXCLUSIVE_HOURS 24 h, so at 24 h the sub-request is settled no_answer while passExpiredLeads hands the lead to the next business: a likely race. |
| Request text min / cap | >= 5 chars; 2000 chars | network.ts:151-153 | 7bcebd1 2026-10-13 | KEEP | |
| Customer-asked filter | noul >= 0.5 (missing -> 1), Jev 10 s | network.ts:161-165 | c5e12f8 2026-10-16 "the agent tends to add extras" | KEEP | |
| ADVERT_ITEMS | 15 items per business; at most 2 per name | network.ts:68, 102 | 3421ac1 2026-10-18; fcf2124 2026-10-19 | KEEP | |
| NEAREST | 30 candidates per business (60 without vectors) | network.ts:69, 80 | fcf2124 2026-10-19 | KEEP | |
| JUDGE_BATCH | 15 items per Jev call | network.ts:70 | 331eab9 2026-10-19 "judges short lists well, long ones poorly" | KEEP |  REPLACED 2026-10-30 by the Haiku item matcher (see changes) |
| Offer match minScore | 0.4; lexical top 10 by 5-letter stems | network.ts:79, 93 | 3421ac1 2026-10-18 | KEEP | |
| MUST_ASK_MAX | 4 | network.ts:71 | 331eab9 2026-10-19 | STALE | Declared, never used (agent.ts:303 hard-codes 4). Its comment is fused with JUDGE_BATCH's. |
| About-text match | noul >= 0.5; about 700 chars; Jev 10 s | network.ts:61, 124-128 | 3421ac1 2026-10-18 | KEEP | |
| Unpriced answer -> owner quote | noul >= 0.5; Jev 8 s | network.ts:322-325 | 78f9326 2026-10-29 "owner asked for the price its assistant left out" | KEEP | |
| Offer text to customer | 4000 chars | network.ts:361-383 | (network offers, 2026-10-26) | KEEP | |
| Broadcast TO_JEV | 50 answers per part to Jev | broadcast.ts:17 | 331eab9 2026-10-19 | KEEP | |
| Broadcast PICKS | 3 offers per part | broadcast.ts:18 | 331eab9 2026-10-19 | KEEP | |
| Broadcast MAX_PARTS | 8 parts; part 2-300 chars; need 3000 chars | broadcast.ts:19, 48-49 | 331eab9 2026-10-19 | CHECK | A large mixed order with more than 8 items silently loses the rest of its parts. |
| Broadcast LLM / Jev timeouts | 60 s / 8 s | broadcast.ts:28, 94 | 331eab9 2026-10-19 | KEEP | |
| Description-only offer | jevBusinessesOffer >= 0.5 | broadcast.ts:117 | 311f4cd 2026-10-22 | KEEP | |
| compare.ts timeouts / threshold | project create race 8 s; wording >= 0.5; writes race 4 s | compare.ts:169, 228, 241 | c9d2ef2 2026-10-10 "project records never block an answer"; bf3727a 2026-10-12 | STALE | runCompare has no runtime caller (only tests and a type import) since 369a40a 2026-10-25 removed estimateProject. |

## E. Leads, invites, reviews

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| LEAD_EXCLUSIVE_HOURS | 24 h (render.yaml "24") | lead.ts:17; routes.ts:361; invite.ts:24 | 7b43ad5 2026-10-20 "24 h reservation"; 254c16f 2026-10-26 | KEEP | Read in 3 places with the same default. See the deadline race in D. |
| Stripe call timeout | 20 s | lead.ts:51 | 7b43ad5 2026-10-20 | KEEP | |
| Subscription cache | 10 min | lead.ts:64 | 7b43ad5 2026-10-20 | CHECK | A business that just paid can still see the lead locked for up to 10 min, unless unlock busts the cache. |
| Expired-lead sweep batch | 20 per sweep (every 10 min) | lead.ts:203 | 7b43ad5 2026-10-20 | KEEP | About 120 per hour is plenty for the pilot. |
| Invite e-mail rate | 1 per business per 24 h | invite.ts:17, 55 | 3421ac1 2026-10-18 | KEEP | |
| Invite text caps | request 800, answer 1500 | invite.ts:67-68 | 3421ac1 2026-10-18 | KEEP | |
| REVIEW_TTL_DAYS | 14 days | review.ts:21, 110, 156 | 3bbd464 2026-10-13 "Businesses approve the agent's work" | CHECK | Shorter than the 30-day conversation TTL, so the review link dies first. Probably fine. |
| AGENT_REVIEW_LATE_MIN | 20 min; reminder once; batch 20 | review.ts:146, 157 | 236c022 2026-10-22 "after 20 min the customer is told where the result will appear" | KEEP | |
| Review stored text | final 20000, note 4000 | review.ts:177 | 3bbd464 2026-10-13 | KEEP | |

## F. Ecosystem relay (src/ecosystem)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| CANDIDATES | 8 businesses judged (by vector) | ecosystem/ask.ts:34 | 1fa6e37 2026-09-30 "ranked top-3 with one Jev call" | CHECK | The 2026-09-30 design comes before the broadcast and the 16-business network. With more members than 8, by-vector pre-selection can drop the right business. |
| MAX_RELAYED | 3 | ask.ts:35 | 1fa6e37 2026-09-30 | KEEP | |
| PASSAGES | 3 per business | ask.ts:36 | 1fa6e37 2026-09-30 | KEEP | |
| VECTOR_FLOOR | 0.3 | ask.ts:37 | 1fa6e37 2026-09-30 | CHECK | Set 3 days after the bge-m3 switch (2026-09-27). Not re-verified since the routing and packs overhaul. |
| QUERY_PARALLEL | 25 | ask.ts:38 | 1fa6e37 2026-09-30 | KEEP | |
| Hand-off token TTL | 24 h | ecosystem/handoff.ts:25 | 4156289 2026-09-30 "hand-off links instead of relaying" | KEEP | |

## G. Flows and the form-driving agent (src/flows, src/agent)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| offeredHere (non-strict) | not_offered >= 0.6; several >= 0.5; Jev 6 s | collect.ts:198 | 3421ac1 2026-10-18 | KEEP | |
| offeredHere strict | offered >= 0.5 | collect.ts:197 | fcf2124 2026-10-19 (used as the form gate since 4d74373 2026-10-26) | CHECK | See the [GATE] row in A. |
| Confirm / cancel | choice >= 0.8 | collect.ts:273 | c6bc8dc 2026-10-23 | KEEP | |
| Reply-language check | noul < 0.5 -> redo | collect.ts:394 | a0d0500 2026-09-29 | KEEP | |
| Claims check | noul >= 0.6 -> regenerate | collect.ts:404 | 4abdc90 2026-10-25 | KEEP | |
| Derived fields | max 10; key 40 / label 80 | collect.ts:76-78 | 6dc45bd 2026-09-29 | KEEP | |
| Form option / missing lists | 5 / 5; knowledge passages 6 | collect.ts:202, 227-229 | 6dc45bd 2026-09-29 | KEEP | |
| Flow cache TTL / sweep | 60 s / 10 min | flow-store.ts:20, 26 | e8c719f 2026-06-05 "Flows: persist in R2" | KEEP | |
| INPUT_MAX_LENGTHS (recorded flows) | text 500, email/phone 100, number/date 50, select 200 | flows/conversation.ts:7-14 | e542682 2026-05-03 initial commit | CHECK | Single-tenant era. Still reachable through processUserInput (chat.ts:474). |
| Executor timeouts | 10 s per step; 2 s per fallback strategy; 3 s load | executor.ts:111, 211, 247 | e542682 2026-05-03 | CHECK | Playwright replay of recorded flows from the original framework. Unclear whether any tenant still has replay flows. |
| Agent step rate limit | 120 requests per IP per minute | agent/routes.ts:23-25 | 6606e5a 2026-09-28 | KEEP | |
| Catalog cache | 10 min, 50 entries | agent/routes.ts:35-37 | 03080f1 2026-09-28 | KEEP | |
| Flow limit | 50 per tenant; goal >= 20 chars | agent/routes.ts:68, 86 | 7dc955c 2026-09-28 | KEEP | |
| Snapshot caps | 200 elements, 60 options, text 6000, errors 8, history 30 | agent/routes.ts:153-167 | 6606e5a / b887d21 2026-09-28 | KEEP | |
| Step history / page | history 12; page text 4000; elements 150; Jev 8 s | step.ts:272, 350-356 | ea8b6ca 2026-09-28 | KEEP | |
| Jev-down retries | 3 WAITs, then manual | step.ts:280 | 35e54f3 2026-09-28 "retry the step when Jev is unavailable" | KEEP | |
| Loop guard | same op on same element 3 times -> manual | step.ts:286 | 6606e5a 2026-09-28 | KEEP | |
| Back allowed | correction within the last 6 steps | step.ts:301 | b887d21 2026-09-28 | KEEP | |
| Consent / final / back gates | consent >= 0.6; final >= 0.5; back >= 0.6; checkbox consent >= 0.6 | step.ts:376-391 | ea8b6ca 2026-09-28 "language-agnostic via Jev" | KEEP | |
| Slot logic | slot_step >= 0.5 and >= 3 clickables; slots >= 0.5; fit >= 0.6; near >= 0.5 (max 8); options >= 0.5 (max 10) | step.ts:418-490 | ea8b6ca / 432ba54 2026-09-28 "stricter slot fit" | KEEP | |
| Choice matching | good >= 0.6, plausible >= 0.2, clear margin 0.2, relevant < 0.5 -> none, list >= 0.1 (6), suggestions >= 0.15 (5) | step.ts:516-540 | 79d916c / 8feb5e6 2026-09-28 "never pick silently" | KEEP | |

## Counts
- KEEP: 77
- CHECK: 30 (8 of them are marked "top suspect" or "suspect": gates that can keep mixed orders away from the agent or network)
- STALE: 5 (QUOTA_EXEMPT_IPS default (partly), collect first-turn hand-over, turnKind, MUST_ASK_MAX, compare.ts)
- NO-TRACE: 0 (every value blames to a commit)

### System-level limits - inventory (repo website-context-packs, branch packs, HEAD 5f642f5, 2026-10-29)

S = scripts/serve-multi-tenant.ts. Traces from `git log -S` / `git log -L`. "Introduced" = earliest commit carrying the literal.

## Anti-abuse set added 2026-10-29 (unmeasured)

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Spend cap per conversation (SPEND_SESSION_USD) | $1.00/day -> "cheap" mode (no network search / project agent) | src/security/budget.ts:14 | 140449b 2026-10-29 "spend caps per conversation/business/day" - "a scripted conversation can't run up a bill" | CHECK | Haiku turn is cents, so $1 is many turns, but no turn cost was measured; network turns (31 Jev + LLM) and agent runs count too. Degrades, doesn't block |
| Spend cap per business (SPEND_TENANT_DAY_USD) | $10/day -> cheap mode | src/security/budget.ts:15 | 140449b 2026-10-29 "one busy or abused widget can't eat the budget" | CHECK | Busy shop/network hub could reach it on a normal day; network search + agent then silently off for that business. No baseline of per-tenant daily spend |
| Global spend cap (SPEND_GLOBAL_DAY_USD) | $80/day -> chat STOPS for every tenant (503 "backend unavailable") | src/security/budget.ts:16 | 140449b 2026-10-29 "the hard stop" | CHECK (could block) | Hard outage for all demos/customers until 00:00 UTC; not compared with real daily OpenRouter spend. Only safeguard is the 80% alert e-mail |
| Spend alert threshold | 80% of tenant/global cap, once/day | src/security/budget.ts:40 | 140449b 2026-10-29 | KEEP | Early warning; alert text says caps live "in render.yaml" - they are NOT in render.yaml (defaults only) |
| Jev token price for spend | $0.042 / 1M tokens | src/security/budget.ts:17 | 140449b 2026-10-29 (no source cited) | CHECK | Hard-coded price; if Jev pricing differs, spend caps mis-count |
| Spend counters in memory, flushed to D1 | every 30 s; loaded once per day per instance | src/security/quota.ts:93 (flush), :59-66 (loadToday) | 140449b 2026-10-29 | CHECK | Each instance adds only its own spend after its day-load: with >1 Render instance caps are effectively multiplied by instance count |
| Quota fallback map cap | 50,000 keys then clear | src/security/quota.ts:41 | 140449b 2026-10-29 | KEEP | Only when D1 down; bounds RAM |
| Project agent runs per conversation (AGENT_RUNS_SESSION) | 3/day | src/llm/chat.ts:1155 | 140449b 2026-10-29 "project agent quotas per conversation/IP/business" | CHECK (could block) | A real customer asking for a 4th quote/calculation in one chat gets a pages-only answer; no data on runs per real conversation |
| Project agent runs per IP (AGENT_RUNS_IP) | 6/day | src/llm/chat.ts:1156 | 140449b 2026-10-29 | CHECK (could block) | Office/carrier NAT (CGNAT is common on PL mobile) or a live demo on a prospect's device shares one IP; demo pass only covers the owner's browser |
| Project agent runs per business (AGENT_RUNS_TENANT) | 60/day | src/llm/chat.ts:1157 | 140449b 2026-10-29 | CHECK | Fine for pilot traffic; a network hub tenant could exceed it; no measurement |
| Jev calls per turn (JEV_TURN_MAX) | 100 (was 30) | src/llm/jev.ts:49 | 140449b 2026-10-29 introduced 30; 5f642f5 2026-10-29 "30 -> 100: a network question needs one judgement per business (31 calls for 16 businesses) - the cap of 30 turned off the fact check" | CHECK (could block) | Scales with network size (~2 calls/business): breaks again at ~50 businesses; the Warsaw base is 168 firms. Should scale with network size or cap per-stage, not a flat number |
| Messages per recipient - SMS (MSG_PER_DAY_SMS) | 3/day | src/projects/notify-channels.ts:89 | 140449b 2026-10-29 "anyone can start requests and give someone else's number" | CHECK (could block) | Customer with several offers + "result ready" on one request in a day loses the 4th update silently ("not sent: daily limit") |
| Messages per recipient - WhatsApp | 5/day | src/projects/notify-channels.ts:89 | 140449b 2026-10-29 | CHECK | Same as SMS, slightly more room |
| Messages per recipient - Telegram | 10/day | src/projects/notify-channels.ts:89 | 140449b 2026-10-29 | KEEP | Free channel, generous |
| Customer e-mails per address (MSG_PER_DAY_EMAIL) | 6/day (offer + result e-mails only) | src/multi-tenant/email.ts:18 | 140449b 2026-10-29 "anyone can ... type someone else's address" | CHECK (could block) | Network request with 6+ offers in a day drops further offer e-mails; owner e-mails (welcome/bot-ready/inquiry) are not capped |
| Cap exemption list (MSG_CAP_EXEMPT) | default "kubalol7982@gmail.com" (email.ts); "" (notify-channels) | src/multi-tenant/email.ts:16, src/projects/notify-channels.ts:90 | 140449b 2026-10-29 | CHECK | Defaults differ between the two files; render.yaml has sync:false so value lives only on Render |
| Quota/spend-exempt IPs (QUOTA_EXEMPT_IPS) | default "79.184.118.71,176.9.1.133" | S:1305 | 88f239f 2026-10-29 "Demo pass ... demos skip quotas and spend caps" | STALE | 176.9.1.133 is the dead GPU box (gone 2026-07); 79.184.118.71 looks like a dynamic home ISP address |
| Demo-pass cookie | 90 days | S:1239 | 88f239f 2026-10-29 | KEEP | Owner-only browser exemption |
| KB uploads per business (UPLOADS_PER_DAY) | 100/day | S:2426 | 140449b 2026-10-29 "Each upload costs reading (vision / embeddings)" | KEEP | Far above normal owner use; only bulk catalogue imports would hit it |
| Onboarding crawl cap, unclaimed (ONBOARD_MAX_PAGES) | 150 pages (was 15) | S:1037, S:1823 | 02fa67a 2026-06-03 introduced 15 "bounded on-demand scrape (keeps Render memory/time/cost in check)"; 140449b 2026-10-29 -> 150 "until the owner sets a password the crawl stops at ONBOARD_MAX_PAGES" | CHECK | Demo quality for big sites depends on it; full crawl only on claim AND only if pagesCount >= 150 (a triaged site that read <150 pages never gets the full crawl) |
| Full crawl after claim (SCRAPE_MAX_PAGES) | 500 pages | S:1824 | 140449b 2026-10-29; plan raised for it 68cbe61 2026-09-28 "500-page scrapes OOM'd 512 MB" | KEEP | Matches the 2 GB plan sizing |
| Interview turns per IP | 60/hour | S:1097-1098 | 6908041 2026-10-29 "interview needs its own key (anyone could overwrite any business's knowledge)" | KEEP | One interview is ~10-30 turns |
| Voice relay token TTL | 10 min | src/voice/relay-token.ts:12 | 6908041 2026-10-29 "voice relay needs a key from the Twilio-signed TwiML ... (SMS pumping)" | KEEP | Covers TwiML -> WebSocket setup gap |
| History check: logged assistant turns compared | last 60 | src/security/history-sig.ts:31 | 140449b 2026-10-29 "signed chat history (forged assistant turns dropped)" | KEEP | Widget sends at most ~20-40 turns |
| Abuse spike alert (ABUSE_SPIKE_ALERT) | 60 events / 10 min, max 1 alert/hour, checked every 5 min | S:1557-1580 (threshold :1562) | 140449b 2026-10-29 | CHECK | foreign_origin is logged on EVERY chat turn from a non-listed domain (staging/second domain of a real customer) and counts toward the spike |
| Abuse events retention | 90 days | S:1573 | 88f239f 2026-10-29 (retention per privacy policy) | KEEP | |
| usage_quota retention | 30 days | S:1574 | 88f239f 2026-10-29 | KEEP | Daily counters |
| spend_daily retention | 400 days | S:1575 | 88f239f 2026-10-29 | KEEP | Year-over-year spend |
| Chat retention (CHAT_RETENTION_DAYS) | 365 days | src/security/retention.ts:10 | db2b0ba 2026-10-29 "Retention as the privacy policy states" | KEEP | Legal promise |
| Expired-project idle window / batch | 30 days idle, 50 projects/run (daily ~8:00 Warsaw) | src/security/retention.ts:13-14 | db2b0ba 2026-10-29 | KEEP | Backlog >50/day drains slowly but fine at current volume |

## Older serving / security limits

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| JSON body size | 5 MB | S:172 | 6ff72bc 2026-05-05 "Multi-tenant infrastructure" | KEEP | Chat is separately capped at 32 KB; flows/KB within 5 MB |
| urlencoded body size | 1 MB | S:174 | 5ead05a 2026-06-03 (Twilio webhooks) | KEEP | |
| Signup / interview-start / onboard-demo per IP | 5/hour (one shared counter) | S:191-196; used S:944, S:1022, S:1073 | 6ff72bc 2026-05-05 | CHECK (could block) | Shared across 3 routes: a prospect trying a few sites, or several people at one office/fair, are blocked for an hour; in-memory per instance |
| Chat per session | 20/min, 100/hour | S:205-206 | 6ff72bc 2026-05-05 | KEEP | Normal chats far below; in-memory per instance |
| Chat per IP backstop | 60/min, 600/hour | S:224-225 | 896bbde 2026-06-01 "per-IP rate backstop ... scripted client can mint unlimited sessions and drain shared OpenRouter credits" | KEEP | Generous (3x session) as the comment intends; in-memory, multiplies with instances |
| Rate-map cleanup | every 10 min | S:231-236 | 6ff72bc 2026-05-05 | KEEP | |
| Auth attempts per account | 10 / 15 min | S:297-298, cleanup S:302 | 02fa67a 2026-06-03 (brute-force protection keyed on account) | KEEP | |
| Messages per chat request | 50 | S:1253 | 02fa67a 2026-06-03 "bounds the prompt size sent to the paid LLM" | KEEP | Widget trims history (slice(-20)) |
| Chat content per request | 32,768 chars | S:1258 | 02fa67a 2026-06-03 (same) | KEEP | |
| Interview transcript turn length | 2,000 chars | S:1102 | ae937c4 2026-07-22 "interview-based KB builder" | KEEP | Input truncation |
| Log ring buffer | 500 lines | S:125 | 1ecbd3a 2026-05-22 "/api/admin/logs endpoint for remote log access" | KEEP | |
| Demo-visit log | 2,000 entries, flushed every 5 s to local disk | S:129, S:134-138 | 9be546f 2026-05-23 / b0bbba7 2026-05-26 "Persist demo visits to disk" | STALE | Written to local data/ - Render is meant to be stateless/horizontally scaled (D1 migration); per-instance file, lost/split across instances |
| Low LLM balance alert (LLM_LOW_BALANCE_USD) | $5 | S:1446 | 4854061 2026-06-01 "proactive low-balance" | CHECK | With an $80/day global cap, $5 is < 2 hours of peak spend - alert may come too late |
| Health probe timeouts | 8 s (BGE, OpenRouter, browserless), 10 s ops e-mail, 15 s email-diag | S:1456, S:1476, S:1498, S:1545, S:1162 | 4854061 / 8c0b649 2026-06-01 | KEEP | |
| health-deep cache | 60 s | S:1517 | 8c0b649 2026-06-01 "Honest chat errors + deep health check" | KEEP | |
| Credit-outage window | 10 min after a 402 | S:1481 | 8c0b649 2026-06-01 | KEEP | |
| Health monitor tick | 4 min | S:1614 | 4854061 2026-06-01 | KEEP | |
| Alert after consecutive bad ticks | 2 (~8 min) | S:1600 | 7af6a67 2026-06-01 "tolerate transient health-check failures" | KEEP | |
| Repeat alert | 1 h | S:1601 | 4854061 2026-06-01 | KEEP | |
| Browserless excluded from alerts | (rule) | S:1592 | 4854061 2026-06-01, comment "serving doesn't use it (VPS scrapes with local Playwright)" | STALE | VPS is gone; on-demand scrapes now run on Render (browserless v2 / local chromium), so a browserless outage breaks onboarding silently |
| Vector re-verify sweep | 40 tenants / 10 min, 3 s retry, 200 ms between probes | S:3503, S:3512, S:3520, S:3526 | 16c71c8 2026-06-01 "re-verify sweep" | CHECK | Runs on every instance (duplicate probes once scaled); ~800+ tenants -> full cycle ~3.5 h, OK |
| Admin rescrape default pages | 20 (?maxPages) | S:1658 | 59317e2 2026-05-06 "Reduce memory pressure: maxPages param" | STALE | Set for the 512 MB box; a rescrape without ?maxPages shrinks a 150/500-page tenant to 20 pages |
| Admin rescrape-all pages | default 10, max 50 | S:1685 | 02fa67a 2026-06-03 | STALE | Same 512 MB-era sizing; would truncate every tenant's KB |
| Dashboard rescrape default pages | 20 | S:2484 | 6ff72bc 2026-05-05 | STALE | Same; no UI caller found, but the route is live for owners |
| Scrape job timeout (SCRAPE_JOB_TIMEOUT_MIN) | 90 min | src/multi-tenant/background-worker.ts:19 | 61a72f1 2026-09-27 introduced; raised 1e21b5c "scrape job limit 90 min (empro.pro ... timed out at 30)" | KEEP | Measured on a real large shop |
| Record token TTL | 60 min | S:2122 | 797bb33 2026-07-20 "Record tokens: stateless HMAC" | KEEP | |
| Owner edit link TTL | 30 days | S:2147 | c712e4d 2026-08-22 "Passwordless owner edit via signed magic-link" | KEEP | |
| Dashboard session TTL | 7 days | src/multi-tenant/d1-auth.ts:45 | 96f7c41 2026-06-05 "D1 registry + auth data layer" | KEEP | |
| bcrypt cost | 10 | src/multi-tenant/d1-auth.ts:33 | 96f7c41 2026-06-05 | KEEP | |
| Recorded flow steps | 200 | S:2204 | e62a935 2026-07-19 "Flow recording ported to multi-tenant" | KEEP | |
| Manual KB entry | 8,000 chars | S:2370, S:2401 | a974722 2026-07-20 "KB editing + gap clearing ported" | KEEP | |
| KB chunk edit | 20,000 chars | S:2640, S:2662 | a127f37 2026-06-05 "Dashboard knowledge base" | KEEP | Inconsistent with the 8,000 above but harmless |
| KB upload size | 15 MB | S:2424 | 21572f1 2026-07-20 "upload documents (PDF/XLSX/CSV/DOCX/TXT)" | KEEP | |
| URL-import chunk size | 1,500 chars | S:2496 | e20f2e6 2026-07-22 "import any public URL" | KEEP | |
| KB page list | 100 vectors (Vectorize topK) -> truncated flag | S:2628 | a127f37 2026-06-05 "the Vectorize query caps at 100" | KEEP | Platform limit, total comes from context-meta |
| Admin bulk ids | 1,000 per call; email-diag 300 | S:3058/3083/3114, S:1176 | 93b62eb 2026-09-29 / 7186024 2026-06-03 | KEEP | Admin-only |
| Knowledge audit delay after scrape | 10 s | S:1908 | 5fc833c 2026-10-26 "Knowledge audit after every scrape" | KEEP | |
| Screenshot browser cache | 1 day immutable | S:352 | 9a1141a 2026-06-03 "Demo perf" | KEEP | |
| Voice end-of-turn (VOICE_SPEECH_TIMEOUT) | 600 ms | S:3273 | dd4968d 2026-09-28 "Voice bot: role-play pitch" | KEEP | |

## Multi-tenant, storage, voice

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Tenant LRU cache (TENANT_CACHE_MAX) | 50 (min 5) | src/multi-tenant/tenant-manager.ts:37 | 26d03fc 2026-06-05 "Bound server RAM: LRU-cap tenant cache ... (OOM fix)" | CHECK | Sized for 512 MB; web service is 2 GB since 68cbe61 2026-09-28 - could be raised if cold-tenant latency matters |
| Tenant idle eviction | 30 min, swept every 5 min | src/multi-tenant/tenant-manager.ts:248, :49 | 6ff72bc 2026-05-05 | KEEP | |
| Inquiries kept per tenant (R2) | last 500 | src/multi-tenant/tenant-manager.ts:303 | 6dc45bd 2026-09-29 "in chat order / inquiry flows" | KEEP | Also e-mailed to owner |
| Ecosystem members considered | 40 | src/multi-tenant/tenant-manager.ts:333 | 1415cea 2026-10-10 "compare_offers@1" | CHECK | Silent cut once an ecosystem exceeds 40 (Warsaw base 168) |
| Registry refresh from D1 | 60 s | src/multi-tenant/d1-registry.ts:120-122 | 96f7c41 2026-06-05 | KEEP | |
| Registry grace for fresh records | 10 min | src/multi-tenant/d1-registry.ts:105 | 75640ea 2026-07-22 "don't clobber just-created tenants on periodic refresh" | KEEP | |
| D1 request timeout (D1_TIMEOUT_MS) | 15 s | src/storage/conversation-store.ts:21 | c9d2ef2 2026-10-10 "Timeouts on OpenRouter (60 s) and D1 (15 s)" | KEEP | |
| D1 401/429 retry wait | 800 ms, once | src/storage/conversation-store.ts:29-30 | e0f9e11 2026-10-13 "hardened from live runs" | KEEP | |
| Dashboard analytics windows | getMessages 100 (x10 firstOnly), conversations 50, first-messages over 1000, top questions over last 500, gaps 200, intents 400 unassigned / 40 clusters | src/storage/conversation-store.ts:152-346 | 1bdb486 2026-05-05; 67d38fb 2026-06-05 "Move conversations + gaps from Qdrant to D1"; c93b00c 2026-07-21 "Intent engine v2" | KEEP | Bounded queries; busy tenants see only recent window |
| Jev timeout (JEV_TIMEOUT_MS) | 2,500 ms, hedges 300/800/1600/3000 | src/llm/jev.ts:51-52 | 2297dee 2026-09-27 "TypeSafe Jev for answerability gate" | KEEP | |
| Voice LLM hedge | 700 ms | src/voice/conversation-relay.ts:203 | dd4968d 2026-09-28 | KEEP | |
| Voice LLM request timeout | 30 s | src/voice/conversation-relay.ts:160 | 6f79a53 2026-06-06 | KEEP | |
| Voice Jev timeout | 1,500 ms | src/voice/turn-classifier.ts:80 | dd4968d 2026-09-28 | KEEP | |
| Eleven conversation state sweep | 30 min idle, every 5 min | src/voice/eleven-llm.ts:37-40 | dd4968d 2026-09-28 | KEEP | |

## render.yaml

| Limit | Value | Where | Trace (commit date + reason) | Assessment | Why |
|---|---|---|---|---|---|
| Web plan | standard (2 GB) | render.yaml:6 | 68cbe61 2026-09-28 "500-page scrapes OOM'd 512 MB" | KEEP | |
| Web persistent disk | 10 GB | render.yaml:12 | 28773d7 2026-05-29 "Stop the disk filling ... grow disk 1->10GB" | CHECK | Screenshots now stream from R2 and registry is in D1; disk use today unverified |
| Qdrant private service + disk | starter, 1 GB | render.yaml:131-141 | 0728210 2026-05-05 "Qdrant as private service"; 5d9fc92 2026-05-28 "Point Render to external Qdrant" | STALE | Prod is Qdrant-free since 67d38fb 2026-06-05; QDRANT_HOST/PORT (render.yaml:29-32) also unused - paid service with no consumer |
| Lead reservation (LEAD_EXCLUSIVE_HOURS) | 24 h | render.yaml:95-96 | 7b43ad5 2026-10-20 "24 h reservation" | KEEP | Product decision |
| Spend caps / agent quotas / message caps / JEV_TURN_MAX / UPLOADS_PER_DAY / ONBOARD_MAX_PAGES | not set | (absent) | - | CHECK | All run on code defaults; budget alert text points to render.yaml where they don't exist. Per the blueprint-sync rule, add them to render.yaml if they're ever tuned on Render |

## Non-limit finding
- src/multi-tenant/tenant-manager.ts:176 default model "qwen/qwen3-235b-a22b-2507" - STALE fallback (prod is anthropic/claude-haiku-5.5 via render.yaml); only matters if OPENROUTER_MODEL is unset.
