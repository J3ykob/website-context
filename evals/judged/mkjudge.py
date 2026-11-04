#!/usr/bin/env python3
"""Turn an eval run (evals/abtest/run.ts output) into judge input files.
usage: python3 mkjudge.py run.json outdir [batches]"""
import json, sys, os
run = json.load(open(sys.argv[1])); out = sys.argv[2]; nb = int(sys.argv[3]) if len(sys.argv) > 3 else 3
os.makedirs(out, exist_ok=True)
cases = {c["id"]: c for c in run["cases"]}
rows = []
for r in sorted(run["results"], key=lambda r: r["id"]):
    c = cases[r["id"]]
    turns, trace = [], []
    for t in r["turns"]:
        turns.append({"user": t["user"], "reply": t["reply"], "first_token_s": round((t.get("firstMs") or 0) / 1000, 1), "total_s": round((t.get("totalMs") or 0) / 1000, 1), "error": t.get("error")})
        d = t.get("debug") or {}
        trace.append({k: d.get(k) for k in ("behaviour", "used", "products", "modelQuote", "computed", "fullOurs", "full", "coverage", "network", "networkSearch", "simpleCalc", "partialOffer") if d.get(k) is not None}
                     | {"route": t.get("route"), "blocked": [d[k]["problems"] for k in ("blocked1", "blocked2") if isinstance(d.get(k), dict)], "agent": t.get("agent")})
    rows.append({"id": c["id"], "tenant": c["tenant"], "category": c["category"], "persona": c.get("persona"), "language": c["language"],
                 "ground_truth": c["ground_truth"], "must": c.get("must", []), "must_not": c.get("must_not", []), "good_reply": c.get("good_reply", ""),
                 "sources": c.get("sources", []), "conversation": turns, "_trace": trace})
for i in range(nb):
    part = rows[i::nb]
    json.dump(part, open(os.path.join(out, f"batch{i+1}.json"), "w"), ensure_ascii=False, indent=1)
    json.dump([{k: v for k, v in x.items() if k != "_trace"} for x in part], open(os.path.join(out, f"batch{i+1}.notrace.json"), "w"), ensure_ascii=False, indent=1)
print(len(rows), "cases ->", out)
