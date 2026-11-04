export const meta = {
  name: 'whisp-pair-judge',
  description: 'Blind paired judging of two runs of the same test conversations: which version is better, by two independent judges per batch',
  phases: [{ title: 'Judge pairs', detail: 'X/Y in random order per case; accuracy first, then completeness, experience, speed' }],
}
const PAIR = { type: 'object', properties: { cases: { type: 'array', items: { type: 'object', properties: {
  id: { type: 'string' }, winner: { type: 'string', enum: ['X', 'Y', 'tie'] }, margin: { type: 'string', enum: ['clear', 'slight'] }, reason: { type: 'string' },
}, required: ['id', 'winner', 'margin', 'reason'] } } }, required: ['cases'] }
const jobs = []
for (let b = 1; b <= args.batches; b++) for (const j of [1, 2]) jobs.push({ b, j })
phase('Judge pairs')
const out = await parallel(jobs.map(({ b, j }) => () => agent(`Read ${args.rules} (what Whisp is). Your file ${args.dir}/pairs${b}.json has test conversations with a business's
website chat. For each case there are two versions of the chat's replies to the same customer messages: conversation_X and conversation_Y
(in random order - nothing tells you which is newer), plus the ground truth, must / must_not and the source pages written by people who read
the business's site. Decide which version is better overall for the customer and the business owner:
1) accuracy first: no wrong or invented facts, prices, promises; no wrong "we don't have it"; 2) completeness: answers what was asked when
the site has it, gives the musts; 3) the experience: direct, clear, right language, sensible next step; 4) speed (first_token_s, total_s)
only when the replies are otherwise about equal. "tie" when they are equally good or bad. When unsure about a fact, open the source page
(python3 -I ${args.helper} <URL>, Bash with dangerouslyDisableSandbox: true). Judge independently; one sentence of reason per case.`, { label: `pairs${b}-judge${j}`, phase: 'Judge pairs', schema: PAIR }).then((r) => (r ? { batch: b, judge: j, ...r } : null))))
return { results: out.filter(Boolean) }
