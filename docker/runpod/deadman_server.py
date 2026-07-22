#!/usr/bin/env python3
"""comfyui-mcp dead-man heartbeat server (pod side) — #269.

Part of the dead-man switch: pods created via runpod_pod_create carry a
watchdog (deadman_watch.sh) that STOPS THE POD when comfyui-mcp's heartbeats
stop (orchestrator crash / laptop closed = the in-process idle auto-stop is
gone too, and without this the pod would bill forever). This tiny stdlib-only
HTTP server is the heartbeat receiver: each GET /heartbeat?token=... refreshes
the beat file the watchdog checks.

Endpoints:
  GET /heartbeat?token=X  -> 200 + refresh beat file (403 on wrong/missing token)
  GET /health             -> 200 (liveness only; does NOT count as a beat)

Env:
  DEADMAN_TOKEN   required; beats without the matching token are rejected.
                  Injected at pod create; derived from the owner's API key +
                  unique deploy name, so it authorizes heartbeats ONLY (it is
                  not the API key and cannot stop the pod).
  DEADMAN_PORT    listen port (default 8189; exposed as an HTTP proxy port).
"""

import os
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import urlparse, parse_qs

TOKEN = os.environ.get("DEADMAN_TOKEN", "")
PORT = int(os.environ.get("DEADMAN_PORT", "8189"))
BEAT_FILE = os.environ.get("DEADMAN_BEAT_FILE", "/tmp/comfyui-mcp-deadman-beat")


class Handler(BaseHTTPRequestHandler):
    server_version = "comfyui-mcp-deadman/1"

    def _reply(self, code: int, body: bytes = b"") -> None:
        self.send_response(code)
        self.send_header("content-type", "text/plain")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        if body:
            self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802 (stdlib handler name)
        url = urlparse(self.path)
        if url.path == "/health":
            self._reply(200, b"ok\n")
            return
        if url.path == "/heartbeat":
            token = parse_qs(url.query).get("token", [""])[0]
            # Constant-time-ish compare isn't worth secrets here (the token is
            # per-deploy + heartbeat-only), but DO require it to be configured.
            if not TOKEN or token != TOKEN:
                self._reply(403, b"forbidden\n")
                return
            with open(BEAT_FILE, "w", encoding="utf-8") as f:
                f.write(str(time.time()))
            self._reply(200, b"ok\n")
            return
        self._reply(404, b"not found\n")

    def log_message(self, *_args) -> None:  # keep the pod console quiet
        pass


if __name__ == "__main__":
    if not TOKEN:
        # post_start.sh gates on this too — refusing to start token-less means a
        # misconfigured pod can never be kept alive by unauthenticated beats.
        raise SystemExit("DEADMAN_TOKEN is not set — heartbeat server refusing to start")
    HTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
