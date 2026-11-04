#!/usr/bin/env python3
"""Print a web page's visible text (line breaks kept) and its same-site links.
usage: python3 -I sitetext.py URL [--links] [--max N]"""
import sys, re, html, urllib.request, urllib.parse, ssl
url = sys.argv[1]; show_links = "--links" in sys.argv
mx = int(sys.argv[sys.argv.index("--max") + 1]) if "--max" in sys.argv else 40000
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE
req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/124 Safari/537.36", "Accept-Language": "pl,en;q=0.8"})
raw = urllib.request.urlopen(req, timeout=40, context=ctx).read()
m = re.search(rb'charset=["\']?([A-Za-z0-9_-]+)', raw[:4000])
enc = (m.group(1).decode() if m else "utf-8")
try: s = raw.decode(enc, "replace")
except LookupError: s = raw.decode("utf-8", "replace")
links = re.findall(r'<a\s[^>]*href=["\']([^"\'#]+)', s, re.I)
s = re.sub(r"(?s)<!--.*?-->", " ", s)
s = re.sub(r"(?is)<(script|style|noscript|svg|template)[^>]*>.*?</\1>", " ", s)
s = re.sub(r"(?i)<br\s*/?>|</(p|div|li|tr|h[1-6]|section|article|header|footer|td|th|table|ul|ol)>", "\n", s)
s = re.sub(r"(?i)<(td|th)[^>]*>", " | ", s)
s = re.sub(r"<[^>]+>", " ", s)
s = html.unescape(s)
lines = [re.sub(r"[ \t ]+", " ", l).strip() for l in s.split("\n")]
out = "\n".join(l for l in lines if l)
print(out[:mx])
if show_links:
    host = urllib.parse.urlparse(url).netloc.replace("www.", "")
    seen = []
    for l in links:
        u = urllib.parse.urljoin(url, html.unescape(l))
        if host in urllib.parse.urlparse(u).netloc and u not in seen and not re.search(r"\.(jpg|jpeg|png|webp|gif|svg|css|js)(\?|$)", u, re.I): seen.append(u)
    print("\n--- LINKS ---"); print("\n".join(seen[:300]))
