# Plan for the next iteration (judges' synthesis after iteration 6, 2026-11-06)

Written by the synthesis agent from the 3 judge lenses of iteration 6 (run at fb95593). Earlier plans are in git history.

# Plan for iteration 7 (judges' synthesis after iteration 6, 2026-11-06)

## Baseline: iteration 6 (fb95593, run 2026-11-06)

**Built since iteration 5 (0968446..fb95593):**
- quantities for every matched item, shop catalogue included;
- calendar periods and stated conversions;
- amounts bound to the quote (a new amounts check);
- the agent starts only when the network has the part;
- one turn graph;
- "not in our offer" only when the pages say so;
- the order form gives the price.

That covers iteration-5 fixes 3 (in part), 7 and 11. Not built: fix 1 (the Business Record is still a design), fixes 2, 4, 5, 6, 8, 9, 10 and 12, and half of the first push.

**Lens results** (count of conversations scoring ≤3 / ≤2 / =1; iteration 5 in brackets):

| Lens | ≤3 | ≤2 | =1 |
|---|---|---|---|
| accuracy | 27 (37) | 14 (20) | 1 (2) |
| customer | 34 (40) | 14 (13) | 0 (1) |
| owner | 31 (35) | 12 (13) | 2 (2) |

- **Any lens ≤3:** 36 of 63 (43). **Any lens ≤2:** 17 (22).
- **Scored 1:** sosnowydwor-2 and aniatkaczyk-1 (3 conversations before).
- **All three lenses pass:** 27 (20).
  - Joined: betonlazy-2, djmw-3, empro-1, helsen-1, kwiaciarniamilosc-3, ostap-1, pelnyparkiet-3, rentbud-1, sosnowydwor-3, whisp-2.
  - Left: kamilkozielewicz-3, whisp-1, whisp-3.
- **Means:** the judges reported only scores ≤3, so means need journal2judges.py and stats.py.
- **README row:** `6 | fb95593 | means pending | first word 3.1 / 5.1 / 8.0 s | pairs 27 - 25 - 11`.

**Blind pairs against iteration 5: even.**
- Verdicts: 58 new, 53 old, 15 tie. Per case: 27 new better, 25 old better, 11 even. The two judges agree on 55 of 63.
- The calculation and routing gains are real (see "What works well"), but about as many conversations got worse.
- Of the 10 clear losses, 5 most likely come from iteration-6 changes:
  - kamilkozielewicz-2: the form's reading change (problem 6);
  - zajacfoto-3 and insanit-1: coverage now marks the part foreign or denied in time, so the turn becomes a network offer. It skips the site's own DJ partner, and it never says what the solar installations do (problem 7);
  - bostabeton-3: the quote now runs, and its "details still needed" line turned "below the minimum" into a hedge;
  - whisp-1: the new quantity reading gets nothing from "na cały rok" (problem 5).
- The other 5 (aniatkaczyk-2, dachywarszawa-2, kamilkozielewicz-3, ostap-2, sweethome-1) took the same route with similar inputs. Where no structure holds the answer, the reply model gets it right in one run and wrong in the next.

**Numbers without judges** (same scripts on both runs):
- **First token:** median 3.1 s, p90 5.1 s, max 8.0 s (was 3.4 / 5.8 / 8.9). 21 turns took 4.5 s or more (was 38). Complete reply p90: 12.5 s (was 9.5).
- **"Not given"** (behaviour partial or partialBare): 53 of 134 turns (was 54). 'full' < 0.5 on 56 of 118 turns.
- **Blocked drafts:**
  - 53 turns, 40% (was 44, 33%), in 72 rounds (was 57);
  - 19 turns hit the 2-round cap (was 13);
  - the 94 reasons given: meta-talk 32, unsupported 23, promises 11, amounts 8, contact 7, hand-off 3, other 10.
- **The new amounts check:**
  - right twice: it stopped 18 300 zł in dworekstaropolski-1 and a 240/270 zł guess in sweethome-3;
  - wrong twice: angelikasolecka-1 (checked against a bad item) and liliowa-1 (one total for two readings).
- **Source pages:** 53% of the cases' source URLs are ever a candidate, and 40% reach the reply (was 53% / 39%), so no data work happened. srccov.py is still not in the repo; these shares come from a scratch re-implementation.
- **Order-form turns:** 11 of 17 arrive in one piece (not streamed).

## Ranked problems

Each count is conversations hurt (any lens ≤3), then how many score ≤2 and how many score 1. A conversation can appear under several problems.

### 1. The fact that answers is missing, wrong, stale or lost its structure in our data (18; 11 at ≤2; 2 at 1)

**Evidence: pages never a candidate in any turn** (as in iteration 5):
- **kwiaciarniamilosc:** 15 of 17 source pages (/regulamin, /dostawa-i-platnosc, /florystyka-funeralna, the wreaths). Meanwhile PL/UA/EN copies of a single page fill the candidates.
  - -1: whether you can pay the courier in cash is left open.
  - -2: no sash (+60 zł), no 30 zł zone fee, no 24 h funeral rule.
- **sweet_home:** 19 of 26.
  - -3: the item reads 'Tort czekoladowy | - PLN', although its page says 95 zł/kg.
  - -1: design items read 'K2 / 9 kg | - PLN', because the K1/K2/K3 price legend is not resolved.
- **romax:** 20 of 23.
- **empro-2:** the shop terms are not a candidate: payment methods, 1-3 days by courier, free shipping from 500 zł.
- **angelikasolecka:** 7 of 13 (/faq, /rezerwuj, /malowanie-twarzy).
- **liliowa-1 T3:** 9 of 14 candidates are copies of the 'Torty dla dzieci' gallery.

**Evidence: missing from the business info card** (the business profile always put in front of the model):
- the NIP, which is in the privacy policy (dachywarszawa-3);
- 'Darmowa wycena' (dachywarszawa-2, -3);
- salon hours without 'Niedziela (zamknięte)' and '( handlowa )' (romax-1).

**Evidence: wrong items:**
- angelikasolecka-1: a /voucher/ dropdown became the item 'Fryzura komunijna + dojazd | 729 PLN', and the amounts check then blocked the correct 330 zł twice.
- rentbud-3: a /wiedza/ guide became a rentable item, 'Rusztowanie aluminiowe jezdne'.
- bostabeton-1, ostap-3: Bosta's pricing-model item mixer_delivery '... do 40 km od wytwórni' was generalised from the TransMix rule. It is still there, and also on Bosta's network card.
- sosnowydwor-2: the per-guest table row 'Obsługa (np. foto; kamera...) - 120 zł' was stored without its table, and the reply sold it as a photographer service (accuracy 1).
- ostap-3: the page and the PDF disagree on prop heights.

**Evidence: two price sources disagree:**
- angelikasolecka-3: the item says 200 zł, the pricing model says 'Wycena indywidualna'.
- dworekstaropolski-1: two ceremony items. The rule (100 zł above 60 / 85 adults, otherwise 2000 zł) exists only as a note.

**Evidence: stale prices.** aniatkaczyk-1 (owner 1): the items read on 31.10 say 2500 / 3500 zł; the live 2027 offer says 3000 / 4200 zł.

**Evidence: page purpose unknown:**
- aniatkaczyk-2 (pair loss): the voucher "order" link opens the redemption calendar.
- angelikasolecka-1: /rezerwuj is never offered.
- zajacfoto-3: VOCART.EU and the photo+video package exist only as FAQ prose.

**Cause (data):** iteration-5 fixes 1 and 6 were not built, and nothing was re-scraped.

**Fix: build the Business Record, phases P0-P2, on the 21 eval tenants, then P7 freshness** (docs/business-record-design.md). It covers:
- copies, translations and pagination grouped;
- page roles, including buy, book and redeem;
- product pages read for price, unit and minimum;
- guides never become items;
- table rows keep their header and unit;
- FAQ and terms pages split into entries;
- every claim cites its sentence, so a rule never moves to another product, and carries its validity against today;
- on the business info card: terms, legal identity, contact roles, per-location hours with their conditions, service areas, and the business's recommended partners;
- pricing-model items rebuilt from the same claims.

**Verify:**
- P0 crawl report ($0): the pages above are read.
- P1 by hand on dworekstaropolski and kwiaciarniamilosc (about $0.08).
- P2 expected facts on the 21 tenants (about $1.8):
  - at least 90% present and current;
  - the traps never current: 729 zł, '40 km' for concrete, 2500 / 3500 zł, the 'jezdne' item, the 120 zł "service".

### 2. Facts we already hold are not selected or not used (15; 7 at ≤2; 1 at 1)

**Evidence: the fact was in a used page, item or quote line, and the reply still denied or hedged:**
- kamilkozielewicz-3 (pair loss): 'REPORTAŻ KRÓTKI SOLO | 3700 PLN' was in the items; the reply said the team would give the price.
- bostabeton-3 (pair loss): the quote said 'Minimum order 4 m³'; the reply said "prawie wystarcza ... nie mam informacji o zasadach zamówień".
- whisp-3: the page says 'forms, orders, bookings'; the reply said "Possibly, but I can't confirm".
- angelikasolecka-3:
  - 'dojazd na terenie Warszawy wliczony' was on a used page; T1 said there was no information about travel to Wola, and T2 said the opposite;
  - face painting at 200 zł was never offered.

**Evidence: in our data but below the cut, or never searched:**
- sosnowydwor-2 T1: nothing was used (/wesela scored 0.40, /cennik 0.29). The reply said it doesn't say whether there is a DJ, although the site says 'W cenę nie wliczony jest ... muzyka'.
- romax-1: only blog posts and the homepage were candidates.
- romax-2 T1: the placeholder 'Panele winylowe Quick-Step | - PLN' was kept over dozens of priced Quick-Step items (Impressive 144,95 zł/m², Blos 169,95 zł/m²).
- insanit-1 (pair loss): the solar gallery and reference pages were candidates (0.71 and 0.68) but unused, so the reply never says the installations heat water.
- zajacfoto-3: the FAQ scored 0.12-0.33.
- angelikasolecka-2: the FAQ line 'nie reguluję brwi' was not selected.
- bostabeton-1: C25/30 was not selected.
- bostabeton-2: SuperFloor CEM was not searched for the shower.
- aniatkaczyk-3: no nearest priced lines.
- djmw-2: the Warszawa/Płock base was not used.
- dachywarszawa-3: the privacy page was used in iteration 5 but is not a candidate now.

**Cause (selection and state):** iteration-5 fix 2 was not built.
- 'partial' is one score for the whole message, so the reply model picks the detail it calls missing.
- Pages are scored whole, so a single FAQ line loses.
- Nothing checks a "not given" claim against what we hold.

**Fix: iteration-5 fix 2, "not given" becomes a per-question structure.**
- The split returns the customer's questions.
- Jev judges each question answered or not over the whole pack, with the computed lines and items first. This replaces 'full'.
- An unanswered question gets one targeted search over all chunks, items and the card, and is judged again.
- Only the questions still unanswered go to the reply model, as the "not given" list. This replaces the free 'partial' rule.
- The check blocks a denial or hedge on a question judged answered, and gives the rewrite that passage.

**Verify:**
- A $0 unit test that items and quote lines fall inside the judged text.
- Smoke kamilkozielewicz-3 alone, then replay the failing turns of these 15 (about 25 turns, about $0.07 plus Jev).
- Targets:
  - "not given" on 25% of turns or fewer (now 40%);
  - no hedge on a question judged answered;
  - source share up;
  - first token no slower.

### 3. The check sends flagged claims, blocks correct ones, and its meta-talk rewrites lose facts (14; 7 at ≤2; 1 at 1)

**Evidence: flagged claims that still went out.** After round 2 the last draft goes out whatever its verdict (chat.ts:1498-1508).
- sweethome-3 T2: "danych kontaktowych nie zapisuję" was flagged in round 2 and sent.
- ostap-2 T2 (pair loss): "nos informations ne réservent pas la location aux entreprises" was flagged, then went out as "notre site ne limite pas la location aux entreprises".
- bostabeton-1 T1: "...strony i cennika" was flagged; a reworded version passed, although there is no price list.

**Evidence: correct statements blocked, because the check lacks the structure that supports them:**
- romax-2 T2: "Dzisiaj mamy 6 listopada 2026, więc ta promocja już się zakończyła" (the check has no today and no validity).
- angelikasolecka-2: a denial that the coverage backed (foreign:none).
- aniatkaczyk-1 T2: "Ursynów ... bez dopłaty" (no computed distance; problem 4).
- rentbud-3 T1: "Rezerwację ... mogę przyjąć tutaj" and "Nic nie zostanie wysłane, dopóki nie potwierdzisz". Both are true, since the form was opening.
- liliowa-1 T2: 610 zł (the quote has one total for two readings).
- zajacfoto-3 T2: the partner link.

**Evidence: meta-talk.**
- It is the top block reason: 32 of 94. 19 first-round blocks were for meta-talk alone, 12 of them in failing conversations.
- The rewrite swaps "our information" for the wording the check allows ('na naszej stronie', "we don't list it on our website", chat.ts:1433). The customer judges read that as a business that doesn't know its own offer.
- The rewrites lose facts:
  - whisp-3 T2: two meta rounds ended in "Possibly";
  - insanit-1: "Na naszej stronie widzimy... nie mamy tam informacji";
  - angelikasolecka-2, ostap-3, bostabeton-2: the rewrite was then blocked as unsupported.

**Evidence: cost.** Every rewrite replaces text the customer has already read. That happened on 40% of turns, and complete-reply p90 is 12.5 s.

**Cause (checks):** iteration-5 fix 4 was not built.
- Verdicts are per statement, with no evidence.
- The check's sources lack today and validity, the coverage verdicts, the computed readings and the chat's own state.
- Flags are not tracked across rounds.
- A style problem blocks like a false fact.

**Fix: claim verdicts with structured evidence, kept as turn state.**
- For each flagged claim, the verifier returns the sentence or structure that supports or contradicts it.
- The sources include:
  - today's date and each item's validity;
  - the coverage verdicts;
  - every computed reading;
  - the problem-4 verdicts;
  - the chat's own state (form open, what it does).
- A flag stays open until no later draft holds the claim (Jev compares).
- Nothing with an open flag is sent. After round 2: an LLM edit that only deletes, checked again; failing that, the existing safe rewrite.
- Meta-talk never blocks on its own; it rides along when another problem forces a rewrite.

**Verify:**
- A $0 test that a draft with an open flag is never returned.
- Replay the blocked turns of these 14 (about 20 turns, about $0.05 plus Jev).
- Targets:
  - no open flag is sent;
  - the 6 false blocks pass;
  - blocked turns 30% or fewer;
  - complete-reply p90 10 s or less.

### 4. Place, distance, weekday and date status are guessed, not computed (9; 7 at ≤2; 1 at 1)

**Evidence: places:**
- dachywarszawa-2 (pair loss): it doubts Bemowo, although the site says 'Obsługujemy Warszawę i okolice'.
- sweethome-1: Wilanów against 'na terenie Warszawy 19,5 zł'.
- aniatkaczyk-1: Ursynów against 'do 30 km od studia'; the correct draft was blocked.
- angelikasolecka-3: Wola against 'dojazd na terenie Warszawy wliczony'; T1 and T2 contradict each other.
- kwiaciarniamilosc-2: Wola in the 'do 10 km' zone, garbled as "Wólka/Wolski".
- djmw-2: Płock against the DJ's base.

**Evidence: dates:**
- kamilkozielewicz-2: "piątek, 18.09.2027" is a Saturday. The form's reading LLM writes weekdays (collect.ts:338).
- romax-2: "nie wiem, czy nadal" for a promotion that ended on 31.10.
- dworekstaropolski-1: "next September" is hedged as possibly 2028.

**Cause (structure):** geography and calendar arithmetic are left to the reply model. The check rightly rejects inferences no sentence states.

**Fix: resolve to structure, compute in code, and pass the verdict on as a fact.**
- An LLM maps each place the customer names to an entry in a static gazetteer: one data file of Polish places and Warsaw districts, with coordinates.
- The business's service areas, zones and radii are structure on its card.
- Code returns the verdict, e.g. "Bemowo: a district of Warszawa - inside the service area" or "Ursynów: N km from the studio - inside 30 km".
- Dates are read as ISO dates; code adds the weekday, the season, and each item's status against today.
- The verdicts go to the reply model and are evidence for the check.

**Verify:**
- Unit tests for lookup, km, weekday and status ($0).
- Replay the 9 turns (about $0.03).
- Targets:
  - no doubt where a verdict exists;
  - no wrong weekday;
  - the romax-2 and aniatkaczyk-1 drafts pass.

### 5. The quote leaves counts, comparisons and sibling packages to the reply model (10; 4 at ≤2; 1 at 1)

**Evidence:**
- **aniatkaczyk-1 (pair loss):** the pricing model reads 'services_needed' ('2500 zł za 5 usług, +500 zł za jedną dodatkową'). The reader counted 5 or fewer for her 6 services, giving "Komfort 2500 PLN for this request". In iteration 5 the reply model corrected this to 3000 zł; in iteration 6 it followed the quote.
- **zajacfoto-1:** only the package she named was priced (7000 zł). Standard (to 1:00) plus plener costs 6500 zł and was never computed.
- **liliowa-1:** "21 cm (ok. 20 porcji)" offered for 25 people.
- **sweethome-1:** "needs weight_kg". The customer gave 80 guests, and the site says 1 kg serves 8-10 people, but that rule is only text inside an input's description.
- **sweethome-3:** 'Tort z logo dla firmy' (minimum 10 kg) quoted as an option for a 1,5 kg cake.
- **angelikasolecka-3:** "on request", although the item is 200 zł/h with a 2 h minimum (3 h = from 600 zł).
- **dworekstaropolski-1 T2:** "próg nie podany"; the threshold rule is a note on another item.
- **bostabeton-3:** 3,7 m³ was never compared with the 4 m³ minimum.
- **djmw-2:** the 2 h beyond the 10 h standard needed a "no rate on the site" line.
- **whisp-1 T2 (pair loss):**
  - the turn was routed to calculate, but "na cały rok" has no digit, so the `/\d/` test on customer text (chat.ts:896, also against the owner's rules) skipped the calculation;
  - the quantity reading returned nothing for a period given only as a length;
  - so there is no 12 x 149 = 1 788 zł.

**Cause (quote model):** iteration-5 fix 3 is half built.
- The LLM still counts units.
- Servings and conditions live in notes.
- There is one package per need.
- Nothing compares the quote with the matched items.

**Fix: finish fix 3 - the reader lists, code counts and compares.**
- **The reader (LLM) returns:** the requested units as a list (one per service, person or piece), a period given only as a length together with its unit, and people counts.
- **Code:**
  - counts units against package capacity and extensions;
  - converts people to the item's unit through its stated serving;
  - compares the quantity with the minimum, and the capacity with the people;
  - prices every sibling package that covers the need, and marks the cheaper one;
  - evaluates conditions held as inputs;
  - adds "no rate on the site" lines;
  - returns lines as quantity x unit price = subtotal.
- **A structure check** flags a line "on request" whose matched item has a price, and an option that is not the need.
- The `/\d/` gate goes.
- The 4 affected pricing models are rebuilt, with servings and conditions as inputs.

**Verify:**
- Unit tests on these 10 requests ($0).
- Replay their price turns (about 12, about $0.04).
- Targets:
  - every amount sent is in the quote;
  - 3000 zł for her 6 services;
  - the 6500 zł alternative;
  - 8-10 kg times the design's rate;
  - "3,7 < 4 m³" stated;
  - 1 788 zł for a year.

### 6. Order and booking turns skip the answer and contradict their own state (6; 3 at ≤2)

**Evidence:**
- **betonlazy-3 T1:** orderAlsoAsks scored 0.34, so the message went straight to the form, with no pages and no checks (chat.ts:868).
  - "Zapisaliśmy zamówienie ... na czwartek 12.11.2026 rano" (reads as an order already placed) is word for word iteration 5's.
  - The pumps were never confirmed.
  - T2 is a ticket built by code (collect.ts:108).
- **kamilkozielewicz-2** (a regression, pair loss): the reading now files details that have no matching field under notes (commit a82929d), so the generic 'Ilość lub zakres prac' field stayed missing. As a result the reply:
  - asked about "oprawa muzyczna" (music) for a photographer;
  - wrote "piątek, 18.09.2027" (a Saturday);
  - claimed a "wstępna rezerwacja";
  - showed no summary, although 5700 / 7700 zł and 'zadatek 600 zł' had been computed.
- **angelikasolecka-1 T2:** "Zapisu nie przyjmuję tutaj" while the form was open.
- **sweethome-3:** "Czy mogę zapisać zamówienie?", then "nie zapisuję", then "To, co już zapisaliśmy".
- The rules still say "this chat can only answer" (chat.ts:1320), and the mid-form reply is not told the form is open.
- **rentbud-3 T2:** 7.0 s, all in one piece; the question pasted under 'Uwagi'; no Saturday hours.
- **insanit-2:** "co mam podać?" left unanswered; "Pan/Pani podał(a)".
- **After a withdrawal, no contact is left:** betonlazy-3, insanit-2, angelikasolecka-1.

**Cause (routing and state):** iteration-5 fix 5 was not built.

**Fix: iteration-5 fix 5, unchanged - one conversation record, and every order turn goes through the checked, streamed reply.**
- **The record holds:**
  - the stage (none, collecting, confirming, sent, withdrawn);
  - typed values;
  - missing fields;
  - the business's own fields, derived once by an LLM from its form or offer type;
  - whether this chat takes orders;
  - the business's contact.
- **How turns use it:**
  - the orderAlsoAsks gate goes: the reply answers, then asks for what is missing;
  - the LLM writes the summary from the record;
  - weekdays come from code (problem 4);
  - the check blocks "recorded / booked / date set" until the stage is 'sent';
  - the "can only answer" clause goes.

**Verify:**
- Replay turns 1-3 of these 6 (18 turns, about $0.05), plus one Jev pass.
- Targets:
  - nothing "recorded" before the customer confirms;
  - every question answered;
  - no summary built by code;
  - every order turn streamed;
  - photographer fields for a photographer.

### 7. The network replaces the business's own offer or partner, or competes with it (6; 3 at ≤2; 1 at 1)

**Evidence:**
- **zajacfoto-3 (pair loss):** film was tagged foreign:none!, although the FAQ sells a combined photo+video service. Network DJs were offered instead of the site's own VOCART.EU.
- **romax-3:** INTER-BUD sells tiles, bathrooms, floors and doors - Romax's own range - and the reply advertised its doors.
- **insanit-1:** the network-check reply never says the installations heat water, and no PV installer is suggested.
- **liliowa-3:** decoration and balloons end with no alternative.
- **ostap-3:** gives Ostap's own phone for pumped concrete, which Ostap does not offer; Bosta's card carries the '40 km' claim.
- **sosnowydwor-2 T2:** "z naszej sieci partnerów", but nobody is named.

**Cause (routing and network):**
- Coverage decides "foreign" from page relevance, not from what the host offers.
- The network match ignores overlap with the host.
- Network cards are built from unchecked items. Iteration-5 fix 10 was not built.

**Fix: capability records with evidence, read first by coverage and by the network.**
- Each capability, of the host and of every network business, carries the business's own sentence and a kind: own, partner-delivered, recommended partner, or not offered.
- A need is foreign only when the host's record says "not offered".
- The host's own recommended partner comes before network businesses.
- A network business whose capabilities overlap the host's is not shown.
- Network cards hold only capabilities with evidence.

**Verify:**
- Rebuild the records for zajacfoto, bostabeton, insanit and romax's window partner.
- Re-run the 6 turns, plus evals/routing/run.ts on the controls betonlazy-1, djmw-2, sosnowydwor-2 and liliowa-3 (about $0.03 in all).

### 8. Slow first word: two quote reads one after the other, and unstreamed order turns (14 conversations with a turn of 5 s or more)

**Evidence:**
- 17 turns made two Haiku quote reads in a row before the reply started streaming (the second read: median 1.7 s).
- Their median first token is 5.1 s, against 3.2 s with one read and 2.9 s with no quote.
- They account for 13 of the 21 turns at 4.5 s or more:
  - aniatkaczyk-1 T1-T3: 8.0 / 6.6 / 5.1 s;
  - djmw-2: 6.3 s; dworekstaropolski-3: 5.8 s; angelikasolecka-1: 5.7 s;
  - romax-2: 5.6 s; sweethome-3 T2: 5.4 s; zajacfoto-1: 5.2 s.
- The second call is either the retry in read() for input names the items do not read (model.ts:279), or the re-read with the items' notes (model.ts:591). The step log does not say which.
- 11 of 17 order-form turns are not streamed: rentbud-3 T2 7.0 s, betonlazy-3 T1 6.1 s, insanit-2 T2 5.0 s.

**Fix: one quote read per turn.**
- Name each read in the step log.
- Give the first read the picked items' notes and their valid input names. It then waits for the item pick (about 1 s), but neither retry is needed.
- Keep a retry only for a structural failure.
- Order turns get streaming through problem 6.

**Verify:**
- Read the step marks ($0).
- Replay the 17 turns (about $0.05).
- Targets:
  - one read on at least 15 of the 17;
  - their median first token 3.5 s or less;
  - overall p90 4.5 s or less.

### 9. What the customer said, and how to address them, is not kept (about 12, mostly at 3)

**Evidence:**
- **Form of address:**
  - "gotowa" (feminine) to Jan (sweethome-3);
  - "Pan/Pani podał(a) ... gotowy(a)" (insanit-2);
  - "Janie" then "panie Janie" (betonlazy-3, kamilkozielewicz-2);
  - "Cześć!" then "Państwa" (angelikasolecka-3, sosnowydwor-2);
  - "planujecie" then "chcesz" (aniatkaczyk-1);
  - "Waszej" then "Ty" (whisp-1).
- **A name the customer never gave:** "Pani Magdo", taken from an e-mail address (liliowa-3).
- **Details asked again after the customer gave them:** liliowa-1, sweethome-3, kamilkozielewicz-3.

**Fix:** the problem-6 record also holds:
- the request's details;
- the name as the customer gave it;
- gender, only if the customer stated it;
- the register.

An LLM sets these once from the customer's own words, and every reply model gets them. One check question compares the draft's form of address and its questions against the record.

**Verify:** one Jev pass over all replies of the next run (about $0.01).

### 10. Owner demo probes (5, all at 3)

**Evidence:**
- **empro-3 (pair loss):** to the owner, "nie mogę podać NIP-u Pana/Pani firmy" and "Poprawki wprowadza właściciel". It never asks for the correct number.
- **bostabeton-1:** "...strony i cennika", for a business with no price list. The system prompt and the check's source line still say "website and price list" (chat.ts:1301, :1375).
- **liliowa-3:** "Pani Magdo".
- **whisp-3:** "Possibly" about Whisp's flagship feature.
- **dachywarszawa-3:** the NIP is denied (problem 1).

**Fix: iteration-5 fix 9.**
- The role is judged over the whole conversation, and kept.
- "About this chat" is built from data.
- An owner's correction is stored as a structured note for the panel.
- "What would you tell a customer about X" runs X through the customer pipeline.

**Verify:**
- ownertest.mts on the 7 probes (about $0.01).
- Targets: owner mode by T2 in 7 of 7; no "price list" for a business without priced items.

### 11. Language slips, and answers that don't come first (about 10, low impact)

**Evidence:**
- **Mixed or broken words:** "реportаж", "міні-плейн", "ceremonia і wesele" (kamilkozielewicz-3). The code's alphabet check passes because the customer typed "USC" in Latin letters.
- **Polish left in other languages, and garbled terms:**
  - "(ramowe, fasadowe)" (ostap-2);
  - "рин" (dachywarszawa-2);
  - "conférenciers (konferansjerzy)" (djmw-3);
  - "recepcję Dworku" (dworekstaropolski-2, pair loss);
  - French without accents (sweethome-2, pair loss).
- **Garbled sentence:** bostabeton-3.
- **Openers that delay the answer:** about 10 replies open with thanks or a pitch.

**Fix: iteration-5 fix 12** - two more questions in the existing check call:
- untranslated, mixed-alphabet or invented words, and missing diacritics: this one blocks;
- does the first sentence answer the main question: this one only rides along with a rewrite that happens anyway.

**Verify:** one Jev pass over the next run's replies.

## What works well; must not break

**Regression set: the 27 conversations that pass all three lenses:**
- aniatkaczyk-2, betonlazy-1, betonlazy-2, dachywarszawa-1, djmw-1, djmw-3, dworekstaropolski-2;
- dworekstaropolski-3, empro-1, helsen-1, helsen-2, helsen-3, insanit-3, kamilkozielewicz-1;
- kwiaciarniamilosc-3, liliowa-2, ostap-1, pelnyparkiet-1, pelnyparkiet-2, pelnyparkiet-3, rentbud-1;
- rentbud-2, sosnowydwor-1, sosnowydwor-3, sweethome-2, whisp-2, zajacfoto-2.

8 of these lost their blind pair. aniatkaczyk-2 lost clearly, on the voucher link. The others lost on small slips: an unsupported 'konsystencja' price factor, "payment terms are set in the contract", an assumed child rate, Polish words in Ukrainian, French without accents.

**Iteration 6's calculations (clear pair wins):**
- empro-1: 3 x 699 = 2 097 zł, with the current promotion;
- rentbud-1: 3 doby = 360 zł, next to 480 zł;
- rentbud-3: 2 doby = 240 zł, and the e-mail in its own field;
- sosnowydwor-3: 40 + 72 + 80 = 192 zł;
- pelnyparkiet-3: booking opens about August 2027, and the 4 700 zł remainder;
- djmw-2: 12 h against the 10 h standard;
- dworekstaropolski-1: 285 x 60 = 17 100 zł;
- romax-2: 4 030,40 zł, and the ended promotion is no longer sold as current;
- liliowa-1: 120 zł, and 610 / 580 zł.

**Routing:** romax-3 says "we don't do windows" and suggests a network firm, with no 4-minute job.

**The amounts check:** it stopped 18 300 zł in dworekstaropolski-1 and the 240/270 zł guess in sweethome-3. Its false blocks come from data and readings (problems 1 and 5), not from the check itself.

**Facts now right:**
- closed on Saturdays (betonlazy-2);
- French-speaking MCs (djmw-3);
- demolition (helsen-1);
- Art. 9 / DPF / SCC (whisp-2);
- the demo explained, with real contacts (kwiaciarniamilosc-3).

**Honesty:**
- no date or availability promised (kamilkozielewicz-2 T1, zajacfoto-1, angelikasolecka-1, rentbud-3, sweethome-3);
- "nothing was sent" after every withdrawal;
- no price invented where none is published (betonlazy-1, bostabeton-1, dachywarszawa-1/-2/-3, helsen-2/-3, aniatkaczyk-3);
- Józefów quoted without a conclusion (sweethome-1 T3).

**Network:**
- other businesses shown as separate firms, with their own real contacts and prices (ostap-3, zajacfoto-3 T1);
- the coverage gate keeps the business's own products in the chat (betonlazy-1: 8,1 m³; bostabeton-3: no network for HydroBeton).

**Other basics:**
- replies in DE, FR, UK and EN from Polish pages;
- exact NIP / KRS / REGON from contact pages;
- honest demo self-descriptions (dachywarszawa-3 T1, liliowa-3, djmw-1).

**Speed:** turns with no quote have a median first token of 2.9 s; withdrawals take 1.9-2.6 s.

## Owner decisions needed

1. **Business Record cap and spend** (open since iteration 5; problem 1).
   - The demo crawl cap is 150 pages; sweethome, romax and angelikasolecka hit it.
   - P2 costs about $1.8; the fleet backfill $25-70.
2. **Hold replies until checked** (open since iteration 3). 40% of turns replaced a draft the customer had already read. Problem 3 should bring that under 30%. Holding the reply costs about +1-2 s before the first word.
3. **Meta-talk stops blocking on its own** (problem 3). A phrase like "z naszych informacji" may then reach a customer when nothing else is wrong. Today, the rewrites it forces lose facts and produce "na naszej stronie nie podajemy".
4. **How to compute distances** (problem 4). Proposed: a static gazetteer file (free, no call per turn). The alternative is a geocoding API (paid, and it adds latency).

## Order and cost

1. **First push.** One push, with the scrape queue empty. $0 tests, then an --only smoke on whisp-1, sweethome-3, ostap-2 and whisp-3 (about $0.03). It contains:
   - nothing with an open flag is sent, and meta-talk blocks only alongside another problem;
   - the "this chat can only answer" clause goes (chat.ts:1320), and the mid-form reply is told the form is open;
   - "website and price list" only when there are priced items (chat.ts:1301, :1375);
   - the `/\d/` gate goes (chat.ts:896);
   - each quote read is named in the step log.
2. **Code, in order:**
   - problems 2 and 3 together; they also replace the stem match on the question (chat.ts:1546) with SKU codes from the split;
   - then 6 and 9 (one record);
   - then 5 and 8;
   - then 4;
   - then 7.
3. **In parallel, offline:** Business Record P0-P2 after decision 1; P7 freshness on aniatkaczyk_pl alone.
4. **Last:** problems 10 and 11.

**Cost and discipline:**
- The targeted replays come to about $0.35 of OpenRouter, plus Jev.
- Read one case by hand before each group.
- New limits get a docs/limits.md row in the same commit.

**Milestone:**
- One 63-case run with blind pairs against iter6/run.json (keep that file): about $0.3 of OpenRouter, plus Jev, plus the judge agents.
- Check both balances first, add evals/judged/srccov.py, and run cleanup-reval.mts afterwards.

## Files
- **/Users/kubal/Desktop/projects/website-context-packs/src/llm/chat.ts:**
  - 868: the orderAlsoAsks gate;
  - 896: `/\d/` on customer text;
  - 1301 and 1375: "website and price list";
  - 1320: "this chat can only answer";
  - 1433 and 1456: the meta-talk question and its block;
  - 1498-1508: the 2-round cap sends the last draft;
  - 1546: the stem match on the question.
- **/Users/kubal/Desktop/projects/website-context-packs/src/flows/collect.ts:**
  - 108: the summary built by code;
  - 338: the reading prompt, where the LLM writes weekdays and details with no matching field go to notes.
- **/Users/kubal/Desktop/projects/website-context-packs/src/pricing/model.ts:**
  - 279: the retry in read();
  - 591: the re-read with the items' notes.
- **/Users/kubal/Desktop/projects/website-context-packs/src/network/coverage.ts** and **src/network/find.ts:** problem 7.
- **/Users/kubal/Desktop/projects/website-context-packs/docs/business-record-design.md:** phases P0-P2 and P7.
- **/Users/kubal/Desktop/projects/website-context-packs/evals/judged/offers/:**
  - bostabeton_pl.pricing-model.json: mixer_delivery "do 40 km";
  - dworekstaropolski_com: two ceremony items;
  - sweet_home_pl: servings only as input text;
  - aniatkaczyk_pl: services_needed;
  - angelikasolecka_pl: the /voucher/ 729 zł item, and face painting "Wycena indywidualna";
  - www_rentbud_pl: items from /wiedza/ guides.
- **/Users/kubal/Desktop/projects/website-context-packs/evals/judged/iter6/run.json:** keep for the next blind pairs.