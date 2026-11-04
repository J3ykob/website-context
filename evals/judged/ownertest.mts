import { readFileSync } from "node:fs";
import { route } from "../../src/llm/router.ts";
// usage: tsx ownertest.mts <run.json> - the router's owner score on the owner-demo turns and a sample of customer turns (Jev only)
const RUN = process.argv[2];
const d = JSON.parse(readFileSync(RUN, "utf8"));
const res = new Map(d.results.map((r: any) => [r.id, r]));
const items: { id: string; owner: boolean; prevU: string; prevA: string; msg: string }[] = [];
for (const c of d.cases) {
  const r: any = res.get(c.id); if (!r) continue;
  const isOwner = c.category === "prospect_probe" && c.id !== "whisp-1";
  // owner cases: every turn; customers: first two turns of the other categories (a sample)
  const turns = r.turns.slice(0, isOwner ? 3 : 2);
  turns.forEach((t: any, i: number) => items.push({ id: `${c.id}#${i + 1}`, owner: isOwner, prevU: i ? r.turns[i - 1].user : "", prevA: i ? r.turns[i - 1].reply : "", msg: t.user }));
}
const pick = items.filter((x) => x.owner).concat(items.filter((x) => !x.owner).filter((_, k) => k % 3 === 0));
let tp = 0, fn = 0, fp = 0, inj = 0;
const rows: string[] = [];
await Promise.all(pick.map(async (x, k) => {
  await new Promise((r) => setTimeout(r, k * 120));
  const rt = await route(x.prevU, x.prevA, x.msg, []);
  if (!rt) { rows.push(`ERR ${x.id}`); return; }
  const o = rt.owner >= 0.7;
  if (x.owner && o) tp++; if (x.owner && !o) fn++; if (!x.owner && o) fp++; if (rt.injection >= 0.8) inj++;
  rows.push(`${x.owner ? "OWNER" : "cust "} owner=${rt.owner.toFixed(2)} inj=${rt.injection.toFixed(2)} ${rt.intent.padEnd(9)} ${x.id.padEnd(22)} ${x.msg.slice(0, 90).replace(/\n/g, " ")}`);
}));
console.log(rows.sort().join("\n"));
console.log(`owner turns found ${tp}/${tp + fn}, customers misread ${fp}/${pick.filter((x) => !x.owner).length}, injection>=0.8: ${inj}`);
