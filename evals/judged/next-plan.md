# Plan for the next iteration (judges' synthesis after iteration 5, 2026-11-05)

Written by the synthesis agent from the 3 judge lenses of iteration 5 (run at 2cadf10). The plan after iteration 4 is in git history (commit 6cd1698).

# Plan for iteration 6 (judges' synthesis after iteration 5, 2026-11-05)

## Baseline: iteration 5 (2cadf10, run 2026-11-04 23:20)

**What was built since iteration 4:**
- the per-part coverage gate for the network and the agent (06febe4..2cadf10, iteration-4 fix 3);
- owner mode at Jev 0.5, and the demo self-description (d91e00f, 8788cae, 77267dd);
- results on unclaimed demos are no longer held (7a75bc1).

The other 12 iteration-4 fixes were not built. The Business Record is only a design (docs/business-record-design.md).

**Lens results** (score ≤3 / ≤2 / =1):

| Lens | ≤3 | ≤2 | =1 |
|---|---|---|---|
| accuracy | 37 | 20 | 2 |
| customer | 40 | 13 | 1 |
| owner | 35 | 13 | 2 |

**Compared with iteration 4:**
- any lens ≤3: 43 of 63 (was 39);
- ≤2: 22 (was 20);
- a 1: 3 (was 4): aniatkaczyk-1, liliowa-1, romax-3;
- all three lenses passed: 20 (was 24).

Means were not computed: only scores ≤3 were reported. Run journal2judges.py and stats.py to get them.

**Where the gate worked:**
- betonlazy-1 (owner 1 in iteration 4) now passes.
- djmw-2 no longer goes to a 125 s calculation with a competitor inside (1 -> 2/3/3).
- The gate also caused the only 1/1/1 (romax-3, problem 11).

**Moves in the pass set:**
- Left: romax-3, pelnyparkiet-3, rentbud-1, sosnowydwor-3, kwiaciarniamilosc-3, betonlazy-2, helsen-1, insanit-1, ostap-1, whisp-2.
- Joined: betonlazy-1, dworekstaropolski-2, dworekstaropolski-3, helsen-2, helsen-3, whisp-1.

**Judge-free numbers:**
- 'partial' on 54 of 134 turns (unchanged).
- 'full' < 0.5 on 57 of 116 judged turns.
- Blocked drafts on 44 turns, in 57 rounds: 27 meta-talk, 15 unsupported, 10 "promises", 6 hand-off.
- Source pages: 53% become candidates and 39% reach the reply. This is a quick re-implementation; srccov.py was lost with its scratchpad, so it is not comparable with 0.64 / 0.49. Re-create it as evals/judged/srccov.py: per case, the share of `sources` URLs among the turn candidates and the used packs.

**First token:**
- median 3.4 s, p90 5.7 s, max 8.9 s (iteration 4: 3.0 / 4.5 / 9.4);
- 37 turns took 4.5 s or more (was 12). Problem 7 explains why this is mostly a measurement change.

**No blind pairs this round:** iteration 4's run.json is gone. Keep evals/judged/iter5/run.json for the next pairs.

## Ranked problems

The count is conversations hurt; how many at ≤2 and at 1 follows. A conversation can appear under more than one problem.

### 1. The answering page or item is not in the knowledge base, or lost its structure (19; 13 at ≤2; 1 at 1)

**Evidence:**
- **kwiaciarniamilosc-1, -2, -3:** 15 source pages were never a candidate in any case: /regulamin/, /dostawa-i-platnosc/, /florystyka-funeralna/, the wreaths and the orchid bouquets. Meanwhile PL/UK/EN copies of a single page filled the candidates. As a result:
  - cash to the courier was left open;
  - the wreath's 1090 zł was withheld;
  - no sash (+60 zł), no zone fee (30 zł to Wola), no orchid bouquets.
- **sweethome-1, -3:**
  - 19 source product pages were never candidates; the 150-page demo cap went on muffins.
  - Wedding cakes show '- PLN' because the K1/K2/K3 legend is not resolved.
  - 'Tort czekoladowy | - PLN', although its page says 95 zł/kg.
  - So the replies guessed K2/K3 rates, 70-90% too high.
- **liliowa-1:** all 14 candidates were 'Torty dla dzieci' gallery copies (?start=N). /smaki was never a candidate, so the reply said 'Tak' to an alcohol-free cake for a 1-year-old.
- **empro-1, -2:** /black-week and /regulamin were never candidates. The reply named the ended MOCNE BRZMIENIE promotion and denied the dispatch time, payment methods and free shipping.
- **romax-2:** the Quick-Step product pages (Creo 74,95 zł/m², Impressive 144,95) were never candidates.
- **romax-1:** 'Niedziela (handlowa)' is lost from the hours.
- **angelikasolecka-1, -2, -3:** /faq, /rezerwuj and /malowanie-twarzy were never candidates.
- **dworekstaropolski-1:** the homepage, /slub-i-wesele and /slub-w-dworku were never candidates, and the season tabs are not attached to their price rows.
- **Profile gaps:**
  - dachywarszawa-2: 'Darmowa wycena' is missing;
  - betonlazy-2: the Saturday closure is missing from the hours;
  - bostabeton-3: the office line is given instead of the sales or 'Produkty specjalistyczne' line.
- **Item error:** Bosta's delivery item carries "do 40 km", taken from its TransMix page, and this reached ostap-3's customer.
- **zajacfoto-3:** the 80-question FAQ is one page, and it scored 0.30.

**Cause (data):** nothing has been re-scraped or re-extracted since iteration 4 (fixes 2, 4 and 7 were not built).

**Fix: build the Business Record, phases P0-P2, on the 21 eval tenants.** It covers:
- listed pages first under the cap, with copies, translations and pagination grouped;
- FAQ and terms pages split into entries;
- dated claims with variants, resolved legends, add-ons and zone tables;
- standing terms, legal identity and contact roles on the always-present card.

**Verify:**
- P0 crawl report ($0) shows the pages above read.
- P1 by hand on dworekstaropolski and kwiaciarniamilosc (about $0.08).
- P2 expected facts on the 21 tenants (about $1.8): at least 90% present and current, and every trap never current.

### 2. Facts Whisp already holds are denied, hedged or dropped (18; 9 at ≤2)

**Evidence: the fact was in a used page or item:**
- dachywarszawa-3 T2: the NIP was denied, with Polityka prywatności used (0.92) and 'full' at 0.96.
- djmw-3: the homepage FAQ says 'Mamy konferansjerów ... Francuski', but 'full' was 0.18, and the reply said "nous ne précisons pas".
- kamilkozielewicz-2: the used '10 pytań' page says 'dojazd do 50 km (np. ... Miętowe Wzgórza)'. The reply said there is no travel price for this venue, and it left out the 600 zł deposit.
- angelikasolecka-3: 'Malowanie twarzy na urodzinach dziecka | 200 PLN' was in the items; the reply said "wycena jest indywidualna".
- romax-2 T1: the used Quick-Step page has prices (Bloom 189,95 zł/m²); the reply said "nie mam podanej ceny za m²".
- betonlazy-2: the used homepage FAQ says 'W soboty firma jest nieczynna'; the reply said "Субота не вказана" (Saturday is not listed).

**Evidence: in the knowledge base, but below the cut or never a candidate:**
- sosnowydwor-2: /cennik/ ('W cenę nie wliczony jest alkohol i muzyka') scored 0.25.
- zajacfoto-3: the FAQ scored 0.30.
- romax-1: all 14 candidates were blog posts; the salon pages were never candidates.
- bostabeton-2 T2: the moisture-resistant SuperFloor CEM was not searched for the new shower condition.
- dworekstaropolski-1 T2: 'Ślub w Dworku | 500 PLN' was dropped, and "our price list has no item" was injected instead.

**Also:** aniatkaczyk-1 T2, aniatkaczyk-3, helsen-1, insanit-1, dachywarszawa-2, angelikasolecka-2 (lash clusters on the used page), whisp-2.

**Cause (selection and state):**
- 'partial' is one score for the whole message. The writer is then told to "say which detail is not given", and it picks one, often one we have. 10 of these 18 conversations had 'partial' on the turn that denied the fact.
- The 'full' judge reads `passages.join().slice(0, 40000)` (chat.ts:1055). The items, the code quote and the coverage passages come after up to 40,000 characters of pages, so they can be cut off.
- Pages are scored whole and the top 4 at 0.5 or more are kept, so a single detail inside a long FAQ or price list loses.
- Nothing checks a "not given" claim: the 'denies' check runs only when nothing was found.

**Fix: "not given" becomes a per-question structure.**
- The split call also returns the questions the customer asked.
- Jev judges each question answered or not, over the whole pack, with the computed lines first. This replaces 'full'.
- An unanswered question gets one targeted search over all chunks, items and the profile, and is judged again.
- Only the questions still unanswered go to the writer, as the "not given" list. This replaces the free 'partial' rule.
- The check blocks any denial of a question judged answered, and passes that question's passage to the rewrite.

**Verify:**
- A $0 unit test that the items and the quote fall inside the judged text.
- Smoke djmw-3 alone, then replay these 18 conversations (about 40 turns, about $0.1 plus Jev).
- Targets:
  - "not given" on 25% of turns or fewer (now 40%);
  - meta-talk blocks halved;
  - source share up;
  - first token no slower.

### 3. Calculations are missing, wrong or overridden (14; 11 at ≤2; 2 at 1; 3 regressions)

**Regressions (passed in iteration 4):**
- **empro-1** (was 2097 zł): shop items never get quantities (`given: new Map()`, chat.ts:931). So the line "No total is computed ... do not work out a total" (chat.ts:1010) is most likely added, and the reply said "nie policzę sumy za 3 szt.".
- **rentbud-1:** the quote reader turned Friday-Monday into "96 h at the cheapest mix" = 480 zł. A same-hour return is 3 doby = 360 zł.
- **sosnowydwor-3:**
  - The barszcz line stayed at "needs: quantity", although the customer gave 8 people and the item says 1 l = 4 portions.
  - The check blocked the right total "40 + 72 + 80 = 192 zł".
  - The rewrite dropped the carp line that the code had priced at 80 zł.

**Not computed:**
- angelikasolecka-3: only the girls' package was priced; face painting at 200 zł/h with a 2 h minimum gives 600 zł for 3 h.
- zajacfoto-1: Standard + plener costs 6500 zł, less than the 7000 zł quoted.
- pelnyparkiet-3: remainder 5500 - 800 = 4700 zł, and booking for August 2028 opens about August 2027.
- djmw-2: 17:00-5:00 is 12 h, 2 h over the standard 10 h counted from the couple's entrance.
- aniatkaczyk-1: her 6 services fit into Premium's 7.
- liliowa-1: 15 x 8 zł = 120 zł, total about 610 zł.
- rentbud-3: Saturday 8:00 to Monday = 2 doby = 240 zł.
- sweethome-1: SH-1101 is K1 at 140 zł/kg with a 9 kg minimum, so 1260 zł.

**Overridden:**
- dworekstaropolski-1: the code said 285 zł x 60 = 17 100 zł. The reply used 305 zł (the 2028 season) = 18 300 zł, and the reworded figure passed the check.

**Cause (the quote model and binding):**
- The reader returns durations as hours, leaves per-person quantities unconverted, and picks one item per need.
- Shops skip the reader.
- Neither the writer nor the check is bound to the code's amounts.

**Fix: the quote returns complete structure, and the reply is bound to it.**
- **Reader (LLM):**
  - a count for each matched item, catalogue items too;
  - the unit conversions the item states;
  - start and return as day + time, or "not given";
  - the event date.
- **Code:**
  - every priced match, plus the sibling tiers for the same need;
  - durations in the price's unit, with calendar arithmetic (both readings when a time is missing);
  - package capacity against the units asked;
  - deposit and remainder, and booking-window dates;
  - line totals, a total, and a running total across turns.
- **Check:**
  - the LLM lists the draft's (item, amount) pairs, and code compares them with the quote;
  - the draft is blocked if it states an amount the quote does not have, or says "no price" where the quote has one.

**Verify:**
- Unit tests on these 14 requests ($0).
- Replay their price turns (about 18, about $0.05).
- Target: every amount sent is in the quote.

### 4. The check sends flagged claims and blocks correct ones (14; 7 at ≤2; 1 at 1)

**Sent although flagged:**
- dachywarszawa-3 T2: the NIP denial was flagged in both rounds, and the third wording went out.
- dworekstaropolski-1 T1: 18 300 zł was flagged; the reworded version passed.

**Unsupported claims that passed:**
- liliowa-1 T3: "Tak, jak najbardziej. Tort bez alkoholu..." (every flavour contains alcohol);
- pelnyparkiet-3: 'Tak', then "cannot be booked yet";
- romax-2 T2: 'Tak, promocja ... obowiązuje' on 4.11, for a promotion that ended 31.10;
- bostabeton-3: "raczej pod podbudowę", although the datasheet says it can be the direct finish;
- rentbud-3: 'jezdne ... mobilne', taken from a general article;
- bostabeton-2: one product's exclusion applied to all products;
- insanit-2: a subsidy implied;
- helsen-1: general advice;
- whisp-3: "Wix included".

**Correct claims blocked, with the fact lost in the rewrite:**
- kwiaciarniamilosc-2: 'od 1090 zł' (blocked over the English size names);
- whisp-2: the Art. 9 clause (blocked over one added clause);
- sosnowydwor-3: the 192 zł total;
- angelikasolecka-1: "Mogę przyjąć zgłoszenie tutaj" (true; it describes what the chat itself does).

**Cause (checks):**
- Verdicts are per statement, with no evidence.
- The rewrite gets the reason but not the sentence.
- After round 2 the last draft goes out whatever its verdict (chat.ts:1202).
- A yes/no stance is not judged as a claim.
- A general article counts as support for a specific product.
- The check sees neither the computed lines nor the chat's own state.

**Fix: claim verdicts with evidence, kept as turn state.**
- **Verdicts:**
  - for each flagged claim, the verifier returns the pack sentence that supports or contradicts it, and says whether that sentence is about this item or is a general article;
  - the direct answer to a yes/no question counts as a claim.
- **Rewrites:**
  - the rewrite gets that sentence and keeps every claim that was not flagged;
  - a flag stays open until no later draft contains the claim (Jev compares the claims);
  - after round 2, an LLM edit that only deletes is checked again, and nothing with an open flag is sent.
- **Sources:** the computed lines and the conversation record (problem 5).

**Verify:**
- Replay these 14 turns (about $0.05).
- Targets:
  - no draft is sent with an open flag;
  - the 4 false blocks pass;
  - the 9 pass-throughs are blocked;
  - blocked drafts on 31% of turns or fewer (now 33%).

### 5. Order turns skip the answer and contradict their own state (8; 4 at ≤2; 1 at 1)

**Evidence:**
- **betonlazy-3 T1:** no pages and no quote. The reply said "Zapisaliśmy zamówienie na beton ... na czwartek 12.11.2026 rano" (reads as an order already placed), and the pumps were never confirmed.
- **liliowa-1 T2:** after 15 cupcakes were added, the form asked for "adresu dostawy" and a name. The bakery offers no delivery, and no price was given.
- **insanit-2 T2:**
  - 'co mam podać?' was copied into the summary;
  - the summary reads like a third-person ticket ("Klient ma w domu ...");
  - notes are joined with '.;'.
- **rentbud-3 T2:**
  - the e-mail address landed under 'Telefon', and the product is generic;
  - no Saturday hours, and no 2 doby total.
- **kamilkozielewicz-2 T2:** the fields "Ilość lub zakres prac" and "Miejsce lub adres zlecenia" were used for a wedding photographer, and the e-mail landed in 'Uwagi'.
- **angelikasolecka-1 T2:** the customer was told to book by phone or e-mail while the form was open, and then asked "Czy mam dopisać coś jeszcze do zgłoszenia?".
- **sosnowydwor-3 T1:** "Dziękujemy za zamówienie", although nothing was ordered.
- **Withdrawals:** in the third turn of 6 cases:
  - the form of address switched ('Janie ... będziesz gotowy'; 'gdy będzie Pani gotowa' to Jan; 'Pan/Pani ... gotowy(a)');
  - no contact was left for later.

**Cause (routing and state):**
- An order message with orderAlsoAsks < 0.7 goes straight to the form (chat.ts:782): no pack, no quote, no facts about the business.
- Code builds the summary from raw values (`• label: value`, collect.ts:105 and :448). This is a template, against the owner's rule.
- Every business gets the same goods-order fields.
- The rules still say "this chat can only answer" (chat.ts:1151).
- The fact check has no source for the open form.
- The withdrawal reply gets neither the form of address nor the contact.

**Fix: one conversation record, and every order turn goes through the checked reply.**
- **The record holds:**
  - the stage (none, collecting, confirming, sent, withdrawn);
  - typed values, with e-mail and phone separate;
  - the missing fields;
  - the business's own fields, derived once from its form or offer type by an LLM;
  - whether this chat takes orders.
- **How turns use it:**
  - the orderAlsoAsks gate goes: the reply (pack, quote, check) answers and then asks for the missing fields;
  - the form only reads values;
  - the LLM writes the summary from the record;
  - the record is a source for the check, which blocks "recorded / booked / date set" until the stage is 'sent';
  - the "can only answer" clause goes.

**Verify:**
- Replay turns 1-3 of these 8 conversations (24 turns, about $0.06), plus one Jev pass over the replies.
- Targets:
  - no "recorded" claim before the customer confirms;
  - every question answered;
  - no e-mail in a phone field;
  - no summary assembled by code;
  - every order turn streamed.

### 6. Ended promotions and changed prices are given as current (5; 4 at ≤2; 1 at 1)

**Evidence:**
- **romax-2 T2:** 'Tak' and 4318,40 zł for a promotion that ended 31.10, although today's date (4.11) is in the prompt.
- **empro-1:** the ended MOCNE BRZMIENIE promotion instead of BLACK RED WEEKS.
- **aniatkaczyk-1 (owner score 1):** the items were read on 31.10; the page now shows Komfort 3000 and Premium 4200 zł, so the reply under-quotes by 500-700 zł.
- **ostap-1:** a 07.2011 price list given as 'Cena katalogowa'.
- **dworekstaropolski-1:** the 2016 English price list is linked, and a 2028 rate is used for 2027.

**Cause (data):** pages and items carry no dates, so the writer has to compare dates itself.

**Fix:** the Business Record's validity (status against today: current, future, ended, superseded), plus the nightly freshness job (P7).

**Verify:**
- A validity report for these 5 tenants from P2 (about $0.02), then replay the 5 cases.
- Targets:
  - romax-2 says the promotion ended 31.10;
  - Komfort shows 3000 zł after the re-read;
  - no link to the 2016 list.

### 7. Slow first word (23 conversations with a turn at 5 s or more)

**Evidence:**
- **The split:** it is one deepseek call, an R2 read and an awaited R2 write (broadcast.ts:99), and none of it is in the step log. It runs before the second search on every offer question:
  - search phase: median 1.5 s on the 84 turns with parts, against 0.5 s on the 27 without;
  - first token: median 3.8 s against 2.3 s.
- **Why the numbers moved:** iterations 2-4 most likely replayed stored splits (cache key v2). Iteration 5 re-keyed them (v3-v5), so every turn paid the model call that production pays for every new message. So this is mostly production's real speed shown for the first time, not a new slowdown.
- **Calculate route:** median 5.3 s, p90 8.7 s.
  - The quote read (two calls in a row: aniatkaczyk-1 T1, 2.8 s + 2.9 s), the item match, the coverage and the simple check all run before the reply.
  - Then the reply searches and scores again: in ostap-1 T1 the reply started only at 6.9 s.
- **Order turns are not streamed:** liliowa-1 T2 8.7 s, betonlazy-3 T1 7.4 s.

**Fix: one turn graph.**
- The split, the searches, the item match and the quote start together.
- Nothing on the path waits for a storage write.
- The calculate route hands its quote, items and coverage to the reply instead of recomputing them.
- Order turns stream (problem 5).

**Verify:**
- Read the step marks in run.json ($0).
- Add a run variant that skips stored splits; otherwise the next run replays iteration 5's splits and looks faster with no change.
- Replay the 10 slowest turns with that variant (about $0.03).
- Targets: median 3.0 s or less, p90 4.5 s or less, calculate-route p90 6 s or less.

### 8. What the customer said is not kept (13, mostly scores of 3)

**Evidence:**
- djmw-2: "w sierpniu 2027" became "wycenę na wrzesień 2027" in the hand-off.
- angelikasolecka-3 and zajacfoto-3 ask again for facts already given; betonlazy-2 asks for the date again.
- The withdrawal slips listed in problem 5.
- pelnyparkiet-3: an assumed 'Pani'.
- liliowa-3: 'Pani Magdo', taken from the e-mail address.
- sosnowydwor-3: a greeting again in the middle of the conversation.

**Cause (state):** the writers read the raw transcript, and the form and withdrawal paths do not get it at all.

**Fix:** the record from problem 5 also holds:
- the request's details, extracted by an LLM: date, place, guests, times, quantities, and the name the customer gave;
- the form of address.

Every writer gets the record. One check question compares the details a draft repeats, and the questions it asks, against it.

**Verify:** one Jev pass over all replies of the next run (about $0.01).

### 9. Owner demo probes (5; 1 at ≤2)

**Evidence:**
- **empro-3:** "podaj NIP mojej firmy" scored 0.35 as an owner message, so the reply said "a nie Pana/Pani firmy". Owner mode started only at T3.
- **kwiaciarniamilosc-3:**
  - T1 says "warto zapytać ... hosting" on a demo nobody installed;
  - in T3 the orchid hypothetical is answered in the abstract, with no bouquets and no contact.
- **dachywarszawa-3 T3:** never says what the customer would be told.
- **bostabeton-1:** "na podstawie ... cennika" for a site with no price list. The fixed intro (chat.ts:1132) and the check's source line (chat.ts:1206) say "website and price list" for every tenant.
- **liliowa-3:** the owner's name taken from the e-mail address.

**Cause (routing and state):**
- The owner score is per message.
- The demo facts are prose.
- A hypothetical customer question is answered in owner mode, with no item matching.

**Fix: owner mode built from state.**
- The router judges the role over the whole conversation, and keeps it.
- The "About this chat" record is built from data: the pages read and when, priced items or none, and that this is a demo made by Whisp and not installed.
- "What would you tell a customer about X" runs X through the customer pipeline and shows its answer.

**Verify:**
- ownertest.mts on the 7 probes (about $0.01).
- Targets:
  - owner mode by T2 in 7 of 7 probes;
  - the hypotheticals show items and contacts.

### 10. Network recommendations misdescribe the business (3; 2 at ≤2)

**Evidence:**
- **sosnowydwor-2:** a photographer was found for "DJ na wesele", and a DJ for "fotograf".
- **ostap-3:** Bosta Beton was offered for "beton z pompą", with "8 m³, do 40 km" taken from its TransMix item.
- **insanit-1:** photovoltaics are not in the offer, and no installer from the network was suggested.

**Cause:**
- The match reads passages that only mention the service.
- The evidence passed to the check includes a line written by code: "<firm> offers, sells, rents or does <part> - checked against its own website" (chat.ts:1417). So a wrong match can never be caught.

**Fix: capabilities carry their own evidence.**
- The capability index stores each capability with the business's own sentence, and whether the business does it itself.
- A business is found only for what it does itself.
- That sentence is the only evidence for the reply and the check; the code-written line goes.

**Verify:** rebuild the entries for djmw, kamilkozielewicz and bostabeton, and re-run the 2 turns (about $0.01).

### 11. A need nobody covers goes to a 4-minute background job (1, scored 1/1/1; a regression caused by iteration 5's gate)

**Evidence:** romax-3, "3 okna ... z montażem":
- the coverage marked the part "foreign:none", and the calculate route called agentTurn (chat.ts:855);
- the reply said "Obliczenie wyceny ... właśnie się rozpoczęło", which reads as Romax quoting windows;
- the job timed out at 241.7 s, and nothing arrived.

**Cause (routing):** a part we do not have starts the agent whenever a network exists, even when nobody in it has the thing.

**Fix:**
- The agent starts only when the network search has a candidate for the part, or for our own priced multi-step work.
- Otherwise the reply says the item is not in our offer, says what we do, and offers the network check.
- An agent timeout releases a knowledge reply.

**Verify:** evals/routing/run.ts on romax-3 plus the controls betonlazy-1, djmw-2, ostap-3, sosnowydwor-2 and liliowa-3 (about $0.01).

### 12. Language slips and filler openers (about 15 conversations, low impact)

**Evidence:**
- **Polish left in other languages:**
  - kamilkozielewicz-3: '80 zdjęć po autorskiej obróbce';
  - ostap-2: '(ramowe elewacyjne)';
  - dachywarszawa-2: '«Wymiana rynien»';
  - sweethome-2: 'cukiernia';
  - dworekstaropolski-2: 'оферта'.
- **A re-spelt place name:** 'Надарзин' for the customer's 'Надажин'.
- **Grammar:** 'le échafaudage', 'Proszę sprawdź'.
- **Openers that delay the answer:** about 15 replies open with lines such as 'Dziękujemy za pytanie!' or 'Congratulations...'.

**Fix:** two more questions in the existing check call:
- untranslated words or a re-spelt name: this one blocks;
- does the first sentence answer the main question: this one is added only to a rewrite that happens anyway, so it causes no new rewrites.

**Verify:** one Jev pass over all replies of the next run.

## What works well; must not break

**Regression set:** the 20 conversations that pass all three lenses:
- aniatkaczyk-2, betonlazy-1, dachywarszawa-1, djmw-1;
- dworekstaropolski-2, dworekstaropolski-3, helsen-2, helsen-3;
- insanit-3, kamilkozielewicz-1, kamilkozielewicz-3, liliowa-2;
- pelnyparkiet-1, pelnyparkiet-2, rentbud-2, sosnowydwor-1;
- sweethome-2, whisp-1, whisp-3, zajacfoto-2.

**The coverage gate:** the business's own products stay in the chat:
- betonlazy-1: 8,1 m³ computed in the chat;
- djmw-2: no competitor inside its quote;
- bostabeton-3: no network offered for its own HydroBeton.

**Sums computed by code and confirmed by the judges:**
- zajacfoto-1: 5500 + 1500 = 7000 zł;
- angelikasolecka-1: 230 / 330 zł;
- romax-2: 32 x 125,95 = 4030,40 zł;
- bostabeton-3: 2,5 and 3,7 m³ against the 4 m³ minimum, and 10,8 cm;
- ostap-1: 2080 -> 2248 zł netto;
- sosnowydwor-3: 40 + 72 zł;
- whisp-1: 149 x 12 = 1788 zł;
- dworekstaropolski-1: the code quote of 17 100 zł.

**Honesty:**
- no date or availability promised (kamilkozielewicz-2, sosnowydwor-2, sweethome-3, rentbud-3);
- "nothing was sent" after all 6 withdrawals;
- "no published price" with the right contact (betonlazy-1, bostabeton-1, dachywarszawa-2).

**Other basics:**
- replies in DE, FR, UK and EN from Polish pages;
- network businesses shown as separate firms with their own contacts ("Nie są to nasi partnerzy");
- exact NIP, KRS and REGON from the contact page or footer.

**Owner mode:** detected from T1 in 6 of 7 probes, with honest demo self-descriptions.

**Speed of short turns:** withdrawals 1.8-2.0 s, owner probes 1.4-3.3 s.

## Owner decisions needed

1. **Agent for parts we don't have** (your wish of 2026-10-26). Either start it only when the network search found a business for the part (proposed, problem 11), or always.
2. **Hold replies until checked** (open since iteration 3). 44 of 134 streamed drafts (33%) were replaced after the customer had seen them, and fixes 2 and 4 add more checking. Either keep streaming, or hold the reply until it is checked (about +1-2 s before the first word).
3. **Business Record cap and spend.**
   - The demo crawl cap is 150 pages; sweethome, romax and angelikasolecka hit it.
   - The spend is about $1.8 for P2 and $25-70 for the fleet backfill.
   - These are the design's decisions 3 and 4.

## Order and cost

1. **First push.** One push, with the scrape queue empty. $0 tests, then one --only smoke on romax-3, empro-1 and angelikasolecka-3 (about $0.02). It contains:
   - fix 11;
   - the 'full' input with the computed lines first (chat.ts:1055);
   - quantities for catalogue items (chat.ts:931, :1010);
   - the "no item" line (chat.ts:1024) added only when no used page has a priced item;
   - the source description built from data (chat.ts:1132, :1206);
   - the split's R2 write no longer awaited, and the split in the step log (broadcast.ts:99);
   - the code that reads customer text removed: the `/\d/` test (chat.ts:809; a router question instead) and the shop's stem match (chat.ts:1348).
2. **Code fixes, in order:**
   - fixes 2 and 7 together (both are in the selection path);
   - then 5 and 8 (one record);
   - then 4, then 3.
3. **In parallel, offline:** Business Record P0-P2 (fixes 1 and 6), then P3 with the queue empty, then the P4 reply test (about $0.75).
4. **Last:** fixes 9, 10 and 12.

**Cost and discipline:**
- Read one case by hand before each group.
- The targeted replays come to about $0.4 of OpenRouter, plus Jev.
- New limits get a docs/limits.md row in the same commit.

**Milestone:**
- One 63-case run with blind pairs against iter5/run.json: about $0.3 of OpenRouter, plus Jev, plus the judge agents.
- Check both balances first, and run cleanup-reval.mts afterwards.

## Files
- /Users/kubal/Desktop/projects/website-context-packs/src/llm/chat.ts (lines 782, 809, 855, 931, 1010, 1024, 1055, 1132, 1151, 1202, 1206, 1348, 1417)
- /Users/kubal/Desktop/projects/website-context-packs/src/llm/packs.ts ('partial' rule at :202, renderPacks at :155, scorePacks at :110)
- /Users/kubal/Desktop/projects/website-context-packs/src/flows/collect.ts (:105, :448)
- /Users/kubal/Desktop/projects/website-context-packs/src/projects/broadcast.ts (splitNeed at :67, the R2 write at :99)
- /Users/kubal/Desktop/projects/website-context-packs/src/network/find.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/pricing/model.ts
- /Users/kubal/Desktop/projects/website-context-packs/src/offer/quantities.ts
- /Users/kubal/Desktop/projects/website-context-packs/docs/business-record-design.md
- /Users/kubal/Desktop/projects/website-context-packs/evals/judged/iter5/run.json (keep for the blind pairs)