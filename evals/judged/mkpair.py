#!/usr/bin/env python3
"""Blind pairs for judging two runs of the same cases: pair inputs + key.
usage: mkpair.py runA.json runB.json outdir batches seed"""
import json, sys, os, random
A, B, out, nb, seed = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), int(sys.argv[5])
ra, rb = json.load(open(A)), json.load(open(B))
cases = {c["id"]: c for c in ra["cases"]}
ia = {r["id"]: r for r in ra["results"]}; ib = {r["id"]: r for r in rb["results"]}
rnd = random.Random(seed); os.makedirs(out, exist_ok=True)
rows, key = [], {}
def conv(r): return [{"user": t["user"], "reply": t["reply"], "first_token_s": round((t.get("firstMs") or 0) / 1000, 1), "total_s": round((t.get("totalMs") or 0) / 1000, 1)} for t in r["turns"]]
for cid in sorted(set(ia) & set(ib)):
    c = cases[cid]; flip = rnd.random() < 0.5
    x, y = (ib[cid], ia[cid]) if flip else (ia[cid], ib[cid])
    key[cid] = {"X": "new" if flip else "old", "Y": "old" if flip else "new"}
    rows.append({"id": cid, "tenant": c["tenant"], "category": c["category"], "persona": c.get("persona"), "language": c["language"],
                 "ground_truth": c["ground_truth"], "must": c.get("must", []), "must_not": c.get("must_not", []), "sources": c.get("sources", []),
                 "conversation_X": conv(x), "conversation_Y": conv(y)})
for i in range(nb): json.dump(rows[i::nb], open(os.path.join(out, f"pairs{i+1}.json"), "w"), ensure_ascii=False, indent=1)
json.dump(key, open(os.path.join(out, "key.json"), "w"), indent=1)
print(len(rows), "pairs ->", out)
