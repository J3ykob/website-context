#!/usr/bin/env python3
"""Turns of a launch-switch run next to iteration 6: launchdiff.py <new run.json> [old iter dir, default iter6]

Prints every turn where a switch acted (unsure fallback, network gone, team quote) with the old reply, the old accuracy
verdict and the new reply - for reading by hand. Counts at the end."""
import json, sys, os

new = json.load(open(sys.argv[1]))
old_dir = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.abspath(__file__)), "iter6")
old = json.load(open(os.path.join(old_dir, "run.json")))
acc = {}
for j in json.load(open(os.path.join(old_dir, "judges.json")))["judgements"]:
    if j["lens"] == "accuracy":
        for c in j["cases"]:
            acc[c["id"]] = c
O = {r["id"]: r for r in old["results"]}
n = {"fallback": 0, "network_gone": 0, "team_quote": 0, "turns": 0, "errors": 0}
for r in new["results"]:
    o = O.get(r["id"])
    for k, t in enumerate(r["turns"]):
        n["turns"] += 1
        if t.get("error"):
            n["errors"] += 1
        d = t.get("debug") or {}
        ot = (o["turns"][k] if o and k < len(o["turns"]) else {}) or {}
        od = ot.get("debug") or {}
        beh = [str(b) for b in d.get("behaviour") or []]
        obeh = [str(b) for b in od.get("behaviour") or []]
        why = []
        if "unsureFallback" in d:
            why.append("fallback"); n["fallback"] += 1
        if any(b.startswith("network") or b == "offerNetwork" for b in obeh) and not any(b.startswith("network") for b in beh):
            why.append("network_gone"); n["network_gone"] += 1
        if "teamQuote" in beh:
            why.append("team_quote"); n["team_quote"] += 1
        if not why:
            continue
        a = acc.get(r["id"], {})
        print(f"\n######## {r['id']} T{k + 1} [{', '.join(why)}]  old accuracy {a.get('score')} ({a.get('root_cause')})")
        print("CUSTOMER:", t.get("user", "")[:400])
        print("--- OLD:", (ot.get("reply") or "")[:1200])
        for p in (a.get("problems") or [])[:3]:
            print("   judge:", p[:300])
        if "unsureFallback" in d:
            u = d["unsureFallback"]
            print("--- REJECTED DRAFT:", (u.get("draft") or "")[:900])
            for p in u.get("problems") or []:
                print("   check:", p[:300])
        print("--- NEW:", (t.get("reply") or "")[:1200])
print("\n", n)
