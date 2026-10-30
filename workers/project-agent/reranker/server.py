"""HTTP front of the reranker (reached only through the Worker's Reranker Durable Object).

POST /score  {"pairs": [[query, text], ...]}  -> {"scores": [p, ...]}   (max 512 pairs)
GET  /health -> {"ok": true}
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rerank import Reranker

MODEL = Reranker("/model")
MAX_PAIRS = 512


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self):
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
            pairs = [(str(q)[:2000], str(d)[:4000]) for q, d in (req.get("pairs") or [])][:MAX_PAIRS]
            if self.path != "/score":
                return self._send(404, {"error": "not found"})
            return self._send(200, {"scores": MODEL.score(pairs) if pairs else []})
        except Exception as e:
            return self._send(500, {"error": str(e)[:300]})

    def log_message(self, *args):
        pass


ThreadingHTTPServer(("0.0.0.0", 8080), Handler).serve_forever()
