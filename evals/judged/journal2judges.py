#!/usr/bin/env python3
"""judges.json (as the workflow returns it) from a judge workflow's journal: journal2judges.py journal.jsonl out.json"""
import json, sys
lab = {}; out = []
for line in open(sys.argv[1]):
    d = json.loads(line)
    if d.get("type") == "started": lab[d["agentId"]] = d["label"]
    if d.get("type") == "result" and isinstance(d.get("result"), dict) and "cases" in d["result"]:
        lens, b = lab[d["agentId"]].split(":batch")
        out.append({"lens": lens, "batch": int(b), **d["result"]})
json.dump({"judgements": out}, open(sys.argv[2], "w"), ensure_ascii=False, indent=1)
print(len(out), "judgements")
