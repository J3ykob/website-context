"""HTTP front of the masker (reached only through the Worker's PiiMasker Durable Object).

POST /mask    {"texts": {key: text}, "allow": [..], "catalog": [..], "state": {..}?}
              -> {"texts": {key: masked}, "state": {..}, "found": n}
POST /unmask  {"texts": {key: text}, "state": {..}}
              -> {"texts": {key: text}, "unknown": [..], "altered": [..]}
GET  /health  -> {"ok": true}

Stateless: the placeholder mapping (state) is kept by the caller, never here.
"""
import json
import socketserver
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from masker import Vault

MAX_BODY = 16 * 1024 * 1024


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._send(200 if self.path == "/health" else 404, {"ok": self.path == "/health"})

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > MAX_BODY:
            return self._send(413, {"error": "too large"})
        try:
            req = json.loads(self.rfile.read(n) or b"{}")
            texts = req.get("texts") or {}
            if self.path == "/mask":
                v = Vault(req.get("allow") or [], req.get("catalog") or [], req.get("state"))
                out, found = {}, 0
                for k, t in texts.items():
                    out[k], f = v.mask(t)
                    found += f
                return self._send(200, {"texts": out, "state": v.state(), "found": found})
            if self.path == "/unmask":
                v = Vault(state=req.get("state"))
                out, unknown, altered = {}, set(), set()
                for k, t in texts.items():
                    out[k], u, a = v.unmask(t)
                    unknown.update(u)
                    altered.update(a)
                return self._send(200, {"texts": out, "unknown": sorted(unknown), "altered": sorted(altered)})
            return self._send(404, {"error": "not found"})
        except Exception as e:  # report, never crash the server
            return self._send(500, {"error": str(e)[:300]})

    def log_message(self, *args):
        pass


class Server(ThreadingHTTPServer):
    # HTTPServer.server_bind resolves the host's FQDN; Cloudflare container hostnames are 64-character
    # labels, which the idna codec rejects ("label too long") - the server died at start.
    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        self.server_name, self.server_port = "masker", self.server_address[1]


if __name__ == "__main__":
    Server(("0.0.0.0", 8080), Handler).serve_forever()
