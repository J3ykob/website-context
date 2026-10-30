# Noise and error plan (2026-10-30)

Goal: the same request, against the same data, gets the same result - and the result is right. Measured
on the network chain test (20 mixed orders) and its 8 network cases run 3 times per version.

## What we measured

- A single 20-case run swings by about 3 cases with no code change.
- Hosted models are not repeatable even at temperature 0 on one pinned provider with a seed:
  Haiku 5.5 gave 4 different answers in 4 calls, deepseek-v4.1-flash 2 in 4 (server-side batching).
  Settings cannot remove this; only design can.
- Before pinning, deepseek calls rotated across ~40 providers with different quantisations (fp4/fp8),
  i.e. a different model per call. Now pinned (src/llm/pin.ts, the agent worker).
- Jev (calibrated decisions): 1 of 57 repeat runs identical, 8 yes/no flips at 0.5. Our own reranker
  (bge-reranker-v2-m3, container): 57/57 identical, 0 flips, same accuracy (off by default: NETWORK_JUDGE).
- The judge (qwen3, LLM) makes mistakes and varies too (C5 graded wrong for exactly what the truth asked).

## Where the noise comes from, and the fix

| # | Source | Example | Fix | Status |
|---|---|---|---|---|
| 1 | Provider rotation / quantisation | deepseek on 40 providers | pin provider + quantisation + seed | done (step 1) |
| 2 | Need split varies | 1 or 2 parts for the same message | store the split per normalised request | done (step 1) |
| 3 | Choices made by a model in free text | "cheapest trestle" 240 vs 350 zł; hourly vs daily rate (C14) | the agent writes its options and choice as structure (wybor.json); code checks the cheapest is chosen and each amount against the item's recipe, failures go to the repair round | done (e09c350) |
| 4 | Arithmetic and totals by the model | per-element scaffolding x guessed counts (C5) | totals only from given quantities (agent check, done); then the recipe evaluator computes | partly |
| 5 | Decisions at a hard threshold | Jev 0.48/0.52 flips a route | an uncertain band (e.g. 0.35-0.65): show both / ask instead of flipping; store decisions per normalised input + data version | next |
| 6 | Reply model writes facts differently each run | C1: price given in one run, not in another | the facts the reply must contain are decided before writing (prices, totals, businesses) and checked after (numbers check exists; add "must mention" check). C1 was not noise but missing data: the chat never saw website-read offer items - now it does | partly (e09c350) |
| 7 | Judge noise and errors | C5, C9 graded against stale/incorrect truths | structured truths (items, prices, totals) checked by code; the LLM judge only for language and tone; 3 judge runs, majority | next |
| 8 | Stale test data | Romax offer changed, C4/C16 | truths carry a data date; a check flags truths whose items no longer exist in the offer | partly: C3/C4/C9/C16 truths corrected and dated |
| 9 | Evaluation protocol | one run decides | always 3 runs per version, report mean and spread; compare versions on the same seeds/cases | adopted |

## Price recipes (the evaluator for #3 and #4)

No universal schema: each offer item carries its own recipe - which inputs it needs (hair length,
wall area, guests, nights, volume, duration...) and how they combine into a price: fixed, per unit,
rate per period with minimum and cheaper long rates, by variant, range, sum of components, alternatives,
formula over the inputs, or on request. Finding the business stays with embeddings (meaning); the recipe
is used only after a match. Outputs are comparable across any business (a price, a range, "needs: X",
or on request), so "cheapest" is a sort in code.

## Test coverage beyond construction

Second network: weddings in Warsaw ("warszawa-wesela", 14 businesses: venues priced per guest with
tiers by guest count and day of week, photographers by package and hours, florists per bouquet with
delivery by distance, DJs per package with extras, cakes per kg with minimum weight, make-up/hair per
person with travel by km). Its chain cases test the recipes on pricing that looks nothing like
construction.
