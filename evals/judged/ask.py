#!/usr/bin/env python3
"""One conversation on production with the turn's trace: ask.py <tenant> <session> <message> [<message> ...]"""
import sys, json, os, urllib.request
tenant, session = sys.argv[1], sys.argv[2]
msgs = []
for q in sys.argv[3:]:
    msgs.append({"role": "user", "content": q})
    req = urllib.request.Request("https://whisp.so/api/chat", data=json.dumps({"tenantId": tenant, "sessionId": session, "messages": msgs}).encode(),
                                 headers={"Content-Type": "application/json", "x-admin-secret": os.environ["ADMIN_SECRET"], "X-Whisp-Probe": "1", "x-test-variant": os.environ.get("VARIANT", "probe")})
    d = json.load(urllib.request.urlopen(req, timeout=200))
    t = d.get("trace") or {}; dbg = t.get("debug") or {}
    print("\nCUSTOMER:", q); print("REPLY:", d.get("message", "")[:900]); print("  ms", t.get("ms"))
    for k in os.environ.get("KEYS", "used,full,behaviour").split(","): print("  ", k, json.dumps(dbg.get(k), ensure_ascii=False)[:700])
    msgs.append({"role": "assistant", "content": d.get("message", "")})
