# Judged eval loop

Realistic test conversations with the chats of real businesses, played on production and scored by independent
judge agents. Used for the November 2026 improvement loop (iterations 0-4).

## What is here
- `cases/*.json` - 63 conversations on 21 businesses (rental, concrete, halls, photo/DJ, beauty/flowers, cakes, roofs,
  plumbing, parquet, Whisp itself). Written by agents from each business's live site and checked by an adversarial
  verifier: persona, the customer's messages, ground truth, must / must_not, a good reply, the source pages.
  The test e-mail is the owner's own (kubalol7982+eval@gmail.com) - never a real customer's.
- `run-iter.sh <iter> [--only id1,id2]` - plays the cases on whisp.so (evals/abtest/run.ts). It sends the probe header,
  so nothing is logged to the businesses' conversations, analytics or gaps. Then it writes the judge inputs
  (`<iter>/judge/batch1-4.json`, with the trace of each turn).
- `judge-workflow.js` - Workflow script: 3 judge lenses (accuracy against the live site, customer experience
  including speed, owner value) x 4 batches, and one synthesis that ranks general fixes.
  Args: `{dir: "<iter>/judge", rules: "judge-rules.md", helper: "sitetext.py", batches: 4}` (absolute paths).
- `mkpair.py runA.json runB.json <out> 4 <seed>` + `pair-workflow.js` + `pairscore.py <out>/key.json result.json` -
  blind pairs: the two versions of each conversation in random order, 2 judges per batch.
- `stats.py <iter>` - latency from run.json and scores from judges.json
  (`journal2judges.py <workflow journal.jsonl> <iter>/judges.json` turns a workflow journal into judges.json).
- `cleanup-reval.mts` - deletes the test conversations ("reval-%" projects, their files, chat rows). Run it after each run.

## Rules
- Smoke-test a change on ONE case (`--only`), read the replies, and only then run the batch.
- A full run costs about $0.3 OpenRouter + Jev. Run it only at milestones, and say the cost first.
- Judges propose fixes within the owner's rules (judge-rules.md): LLM words every reply, code only gates and computes
  structure, no special cases, less prompt.
- Absolute scores move about +-0.15 between judging rounds. The blind pairs are the comparison to trust.

## Results (November 2026)
| Iteration | Commit | Accuracy | Customer | Owner | First word median / p90 / max | Pairs vs previous |
|---|---|---|---|---|---|---|
| 0 | 5f49aac | 3.10 | 2.98 | 3.00 | 3.3 / 6.6 / 19.5 s | - |
| 2 | eeb22cd | 3.25 | 3.13 | 3.21 | 2.9 / 5.2 / 7.6 s | 45 - 17 - 1 (new - old - even) |
| 3 | 4151af8 | 3.14 | 3.22 | 3.27 | 2.9 / 5.1 / 9.5 s | 41 - 15 - 7 |
| 4 | 439c2fe | 3.33 | 3.32 | 3.22 | 3.0 / 4.5 / 9.4 s | 29 - 24 - 10 |
| 5 | 2cadf10 | 3.17 | 3.19 | 3.32 | 3.4 / 5.7 / 8.9 s | no pairs (iteration 4's run was not kept) |
| 6 | 8518411 (+fb95593 shop totals) | 3.52 | 3.25 | 3.44 | 3.1 / 5.1 / 8.0 s | 27 - 25 - 11 vs iteration 5 |

Iteration 5 = the network only for what the business lacks, demos release results, password reset, privacy fixes. Its
first-word times are production's real speed: iterations 2-4 replayed stored request splits (cache key v2), iteration 5
re-keyed them, so every turn paid the split's model call (judges' synthesis, next-plan.md problem 7).

The ranked plan for the next iteration (the judges' synthesis) is in `next-plan.md`.
