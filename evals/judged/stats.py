#!/usr/bin/env python3
"""Summary of one iteration: latency from run.json, scores from judges.json (workflow result).
usage: stats.py <iterdir>"""
import json, sys, os, statistics as st, collections
d = sys.argv[1]
run = json.load(open(os.path.join(d, "run.json")))
cases = {c["id"]: c for c in run["cases"]}
first, total, routes, errors = [], [], collections.Counter(), 0
for r in run["results"]:
    for t in r["turns"]:
        if t.get("error"): errors += 1
        if t.get("agent"): routes["agent"] += 1; continue
        routes[t.get("route") or "?"] += 1
        if t.get("firstMs"): first.append(t["firstMs"] / 1000)
        if t.get("totalMs"): total.append(t["totalMs"] / 1000)
def pct(xs, p): xs = sorted(xs); return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else 0
print(f"turns {sum(routes.values())}, errors {errors}, routes {dict(routes)}")
print(f"first token s: median {st.median(first):.1f}  p90 {pct(first, .9):.1f}  max {max(first):.1f}")
print(f"total s:       median {st.median(total):.1f}  p90 {pct(total, .9):.1f}  max {max(total):.1f}")
jf = os.path.join(d, "judges.json")
if os.path.exists(jf):
    J = json.load(open(jf))
    by = collections.defaultdict(dict)
    for j in J["judgements"]:
        for c in j["cases"]: by[c["id"]][j["lens"]] = c
    for lens in ("accuracy", "customer", "owner"):
        sc = [v[lens]["score"] for v in by.values() if lens in v]
        if sc: print(f"{lens:9s} mean {st.mean(sc):.2f}  pass(>=4) {sum(s >= 4 for s in sc)}/{len(sc)}  fails(<=2) {sum(s <= 2 for s in sc)}")
    cat = collections.defaultdict(list)
    for cid, v in by.items():
        if cid in cases and v: cat[cases[cid]["category"]].append(st.mean(x["score"] for x in v.values()))
    print("by category: " + ", ".join(f"{k} {st.mean(v):.1f} (n={len(v)})" for k, v in sorted(cat.items(), key=lambda x: st.mean(x[1]))))
    rc = collections.Counter(c["root_cause"] for j in J["judgements"] if j["lens"] == "accuracy" for c in j["cases"] if c["score"] <= 3)
    print("accuracy root causes (score<=3):", dict(rc.most_common()))
