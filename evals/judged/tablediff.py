#!/usr/bin/env python3
"""The turn table next to the chain: tablediff.py <iterdir> [--read]

run.json must hold both variants (run.ts --variants current,table). Prints
  1. speed per variant;
  2. on the chain's turns: where the table, given the very same state record, decides differently (no model noise);
  3. the rows the table used on its own run;
  4. with --read: both replies of every turn the table decided differently on, for reading by hand."""
import json, sys, os, statistics as st, collections

d = sys.argv[1]
read = "--read" in sys.argv
run = json.load(open(os.path.join(d, "run.json")))
by = collections.defaultdict(dict)
for r in run["results"]:
    by[r["id"]][r["variant"]] = r

def pct(xs, p):
    xs = sorted(xs); return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else 0

print("== speed")
for v in ("current", "table"):
    first, total, err, n = [], [], 0, 0
    for c in by.values():
        for t in (c.get(v) or {}).get("turns", []):
            n += 1
            if t.get("error"): err += 1
            if t.get("firstMs"): first.append(t["firstMs"] / 1000)
            if t.get("totalMs"): total.append(t["totalMs"] / 1000)
    if first:
        print(f"{v:8s} turns {n} errors {err} | first word: median {st.median(first):.1f} p90 {pct(first, .9):.1f} max {max(first):.1f} | whole reply: median {st.median(total):.1f} p90 {pct(total, .9):.1f} max {max(total):.1f}")

NORM = {"noInfoBare": "noInfo", "partialBare": "partial"}
DECIDED = {"answer", "noInfo", "partial", "handoff", "notOffered", "teamQuote", "simpleCalc", "askInputs", "offerNetwork", "network", "networkAlso", "networkCheck", "networkCheckAlso"}

def chain_set(dbg):
    return {NORM.get(b, b) for b in (dbg.get("behaviour") or [])} & DECIDED

def table_set(t):
    out = set()
    body = t.get("body")
    if body == "answer": out.add("answer")
    if body == "noInfo": out.add("noInfo")
    if body == "network": out.add("networkAlso" if t.get("withOurs") else "network")
    if body == "networkChecking": out.add("networkCheckAlso" if t.get("withOurs") else "networkCheck")
    if t.get("notOffered"): out.add("notOffered")
    out |= {"teamQuote": {"teamQuote"}, "compute": {"simpleCalc"}, "askInputs": {"askInputs"}}.get(t.get("price"), set())
    if t.get("partial"): out.add("partial")
    if t.get("offer") in ("question", "quote"): out.add("handoff")
    if t.get("offer") == "network": out.add("offerNetwork")
    return out

print("\n== the same state, decided by the chain and by the table (the chain's run)")
same = diff = 0
kinds = collections.Counter()
changed = []
for cid, c in sorted(by.items()):
    for k, t in enumerate((c.get("current") or {}).get("turns", [])):
        dbg = t.get("debug") or {}
        tb = dbg.get("table")
        if not tb: continue
        a, b = chain_set(dbg), table_set(tb)
        ck = (dbg.get("partialOffer") or {}).get("kind")
        kind_diff = "handoff" in a and "handoff" in b and ck in ("question", "quote") and ck != tb.get("offer")
        if a == b and not kind_diff: same += 1; continue
        diff += 1
        what = ", ".join([f"+{x}" for x in sorted(b - a)] + [f"-{x}" for x in sorted(a - b)] + ([f"offer {ck}->{tb.get('offer')}"] if kind_diff else []))
        kinds[what] += 1
        changed.append((cid, k))
        print(f"{cid} T{k + 1}: {what}   state: {json.dumps({x: y for x, y in (dbg.get('state') or {}).items() if x in ('intent', 'asksPrice', 'info', 'price', 'missing', 'calc', 'parts')}, ensure_ascii=False)[:300]}")
print(f"turns decided: {same + diff}, same {same}, different {diff}")
for w, n in kinds.most_common(): print(f"  {n:3d}  {w}")

print("\n== rows the table used (its own run)")
rows = collections.Counter()
for c in by.values():
    for t in (c.get("table") or {}).get("turns", []):
        tb = (t.get("debug") or {}).get("table")
        if tb and tb.get("used"): rows[" | ".join(tb.get("rows") or [])] += 1
for w, n in rows.most_common(): print(f"  {n:3d}  {w}")

if read:
    print("\n== both replies where the table's own run decided differently from the chain's run")
    for cid, c in sorted(by.items()):
        cur, tab = (c.get("current") or {}).get("turns", []), (c.get("table") or {}).get("turns", [])
        for k in range(min(len(cur), len(tab))):
            a, b = chain_set(cur[k].get("debug") or {}), chain_set(tab[k].get("debug") or {})
            if a == b and (cid, k) not in changed: continue
            print(f"\n######## {cid} T{k + 1}  chain {sorted(a)}  table {sorted(b)}")
            print("CUSTOMER:", (tab[k].get("user") or "")[:500])
            print("--- CHAIN:", (cur[k].get("reply") or "")[:1300])
            print("--- TABLE:", (tab[k].get("reply") or "")[:1300])
            print("    table state:", json.dumps((tab[k].get("debug") or {}).get("state"), ensure_ascii=False)[:400])
