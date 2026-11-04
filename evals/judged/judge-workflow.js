export const meta = {
  name: 'whisp-judge',
  description: 'Independent judges score every test conversation (accuracy, customer, business owner) and propose general fixes; a synthesis ranks them',
  phases: [
    { title: 'Judge', detail: '3 lenses x batches, each judge independent and blind to the others' },
    { title: 'Synthesize', detail: 'one agent merges all judgements into a ranked, general fix plan' },
  ],
}

const D = args.dir, RULES = args.rules, HELPER = args.helper, NB = args.batches
const CASES = {
  type: 'object',
  properties: {
    cases: { type: 'array', items: { type: 'object', properties: {
      id: { type: 'string' },
      score: { type: 'integer', minimum: 1, maximum: 5 },
      problems: { type: 'array', items: { type: 'string' } },
      root_cause: { type: 'string', enum: ['ok', 'data_missing', 'selection', 'reasoning', 'routing', 'check_or_rewrite', 'quote_model', 'network', 'language', 'tone_or_format', 'latency', 'ground_truth_wrong', 'other'] },
      fix: { type: 'string' },
    }, required: ['id', 'score', 'problems', 'root_cause', 'fix'] } },
    top_issues: { type: 'array', items: { type: 'object', properties: {
      issue: { type: 'string' }, cases: { type: 'array', items: { type: 'string' } }, general_fix: { type: 'string' }, impact: { type: 'string', enum: ['high', 'medium', 'low'] },
    }, required: ['issue', 'cases', 'general_fix', 'impact'] } },
  },
  required: ['cases', 'top_issues'],
}

const COMMON = `Read ${RULES} first (what Whisp is, and the owner's rules any fix you propose must respect).
Each case in your file: the business (tenant), the customer's messages and Whisp's replies (conversation[]: user, reply,
first_token_s, total_s), the case author's ground_truth / must / must_not / good_reply, and the source pages.
The ground truth was written from the business's live website and checked by a second person, but it can still be wrong:
when a reply contradicts it, open the source page yourself (python3 -I ${HELPER} <URL> --links, Bash with
dangerouslyDisableSandbox: true) before scoring, and mark root_cause "ground_truth_wrong" if the reply was right.
A reply that says a calculation "is being prepared / will appear here" is what the customer actually got in that turn
(the background calculation's later result is appended only when it arrived within 4 minutes).
Judge every case in your file. Be strict and concrete; quote the exact words that are wrong. Score 1-5 (5 = excellent).
"fix" = the concrete, GENERAL change you recommend for this case's failure (or "-" when it is fine).
top_issues = the recurring problems across your cases, each with the case ids and one general fix.`

const LENS = {
  accuracy: `You are the ACCURACY judge. Score only whether what Whisp said is true and complete for this business:
5 = every fact right and every "must" given, nothing invented; 4 = right, a minor omission/imprecision; 3 = partly right (a must
missing, vague where the site is precise, a needless "I don't know"); 2 = a wrong fact, number, wrong denial ("we don't have X"
when they do) or the main question unanswered although the site answers it; 1 = invented or harmful (a made-up price, promise,
availability; another business's offer as its own). Check arithmetic. Each case also has _trace (per turn: what our system
selected - pages "used", offer items "products", the business's quoting model output "modelQuote", the checks that blocked
a draft, the behaviour chosen). Use _trace ONLY to name the root cause (data_missing = the site has it but nothing we
selected contains it / selection = it existed in our data but the wrong pages or items were picked / reasoning = the right
info was in front of the model and the reply still got it wrong / check_or_rewrite = a check blocked a good draft or the
rewrite broke it / quote_model / routing / network / language).`,
  customer: `You are the CUSTOMER judge: a real person who wrote these messages to a business's website chat. Score how well you
were served: did you get a direct, usable answer to what you asked (first sentence), in your language and register, short
and clear, with a sensible next step (at most one question back), natural tone (not robotic, not salesy, no repetition,
no filler like "great question"), follow-ups understood in context, and was it fast (first_token_s under ~3 s good,
over 5 s slow, over 8 s very slow - say so). A polite non-answer is a 2. Do not check facts against the site (another
judge does); judge the experience.`,
  owner: `You are the BUSINESS OWNER judge: the owner of this business, deciding whether to keep this chat on your site and pay
149 zł/month for its panel. Score whether each reply helps your business: represents you accurately and well, moves the
customer toward buying/booking/contacting YOU (a clear next step when there is buying intent, your phone/e-mail when the
chat can't help), never loses a sale by a needless "we don't have it", never sends your customer to a competitor when you
can serve them yourself (recommending network partners only for what you don't do is fine), never promises what you can't
deliver, never quotes a price you'd have to honour that is wrong. For persona owner_testing_demo (the owner poking at a demo
of a chat built from his own site): would this make him trust it and buy, or put him off?`,
}

const jobs = []
for (const [lens, prompt] of Object.entries(LENS))
  for (let b = 1; b <= NB; b++)
    jobs.push({ lens, b, file: `${D}/batch${b}${lens === 'accuracy' ? '' : '.notrace'}.json`, prompt })

phase('Judge')
const results = await parallel(jobs.map((j) => () =>
  agent(`${COMMON}\n\n${j.prompt}\n\nYour cases: read ${j.file}.`, { label: `${j.lens}:batch${j.b}`, phase: 'Judge', schema: CASES })
    .then((r) => (r ? { lens: j.lens, batch: j.b, ...r } : null))))

phase('Synthesize')
const ok = results.filter(Boolean)
log(`${ok.length}/${jobs.length} judges returned`)
const synthesis = await agent(`Read ${RULES}. Below are the independent judgements of Whisp's replies by three kinds of judges
(accuracy, customer, owner), each over batches of the same test conversations (the cases are in ${D}/batch*.json).
Produce the plan for the next iteration: the problems ranked by how many conversations they hurt and how badly, each with
(1) the evidence (case ids, what went wrong), (2) the most likely root cause in Whisp (data, selection, reasoning, routing,
checks, latency...), (3) ONE general fix that respects the owner's rules (no regexes on text, no special cases, LLM writes
all customer words, prefer data/selection/state/check fixes over new prompt rules), (4) how to verify it cheaply.
Also list what works well and must not be broken. Be concrete and short.

Judgements:
${JSON.stringify(ok.map((r) => ({ lens: r.lens, batch: r.batch, top_issues: r.top_issues, failing: r.cases.filter((c) => c.score <= 3).map((c) => ({ id: c.id, score: c.score, problems: c.problems, root_cause: c.root_cause, fix: c.fix })) })))}`,
  { label: 'synthesis', phase: 'Synthesize' })
return { judgements: ok, synthesis }
