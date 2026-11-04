#!/usr/bin/env python3
"""Paired verdicts -> new vs old: pairscore.py key.json pairs-result.json [cases.json for categories]"""
import json, sys, collections
key = json.load(open(sys.argv[1])); res = json.load(open(sys.argv[2]))
per = collections.defaultdict(list)
for r in res["results"]:
    for c in r["cases"]:
        if c["id"] not in key: continue
        w = c["winner"]; per[c["id"]].append("tie" if w == "tie" else key[c["id"]][w])
tot = collections.Counter(v for vs in per.values() for v in vs)
agree = sum(1 for vs in per.values() if len(vs) == 2 and vs[0] == vs[1])
both = sum(1 for vs in per.values() if len(vs) == 2)
print(f"verdicts: new {tot['new']}  old {tot['old']}  tie {tot['tie']}  (cases {len(per)}, judges agree on {agree}/{both})")
case = collections.Counter()
for cid, vs in per.items():
    s = sum(1 if v == "new" else -1 if v == "old" else 0 for v in vs)
    case["new" if s > 0 else "old" if s < 0 else "even"] += 1
print(f"per case (judges summed): new better {case['new']}, old better {case['old']}, even {case['even']}")
olds = [cid for cid, vs in per.items() if sum(1 if v == "new" else -1 if v == "old" else 0 for v in vs) < 0]
print("old better in:", ", ".join(sorted(olds)))
