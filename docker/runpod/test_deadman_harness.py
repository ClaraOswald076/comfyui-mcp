#!/usr/bin/env python3
"""Local harness for docker/runpod/deadman_watch.sh — NOT shipped.

Simulates RunPod's GraphQL endpoint and drives the watchdog through its three
paths: (A) never-managed boot grace -> stop, (B) beats then silence -> stop,
(C) DEADMAN_DISABLE=1 -> inert. Exits non-zero on any failure.
"""
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WATCH = ROOT / "deadman_watch.sh"
stops: list[dict] = []

# `bash` on PATH may resolve to WSL (which can't see C:/ paths) — prefer Git Bash.
_GIT_BASH = Path("C:/Program Files/Git/bin/bash.exe")
BASH = str(_GIT_BASH) if _GIT_BASH.exists() else (shutil.which("bash") or "bash")


def sh_path(p) -> str:
    """Git Bash accepts C:/... but chokes on C:\\... — normalize separators."""
    return str(p).replace("\\", "/")


class MockGql(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        stops.append(body)
        out = json.dumps({"data": {"podStop": {"id": "podX", "desiredStatus": "EXITED"}}}).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


def run_watch(env_extra, beat_file):
    env = {
        **os.environ,  # full PATH — Git Bash's curl lives in /mingw64/bin
        "RUNPOD_API_KEY": "test-key",
        "RUNPOD_POD_ID": "podX",
        "RUNPOD_GRAPHQL_ENDPOINT": "http://127.0.0.1:18199/graphql",
        "LOG_DIR": sh_path(tempfile.mkdtemp(prefix="deadman-log-")),
        "DEADMAN_BEAT_FILE": sh_path(beat_file),
        "DEADMAN_TICK_S": "1",
        **env_extra,
    }
    return subprocess.Popen([BASH, sh_path(WATCH)], env=env)


def wait_for_stop(proc, timeout=12):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if stops:
            return True
        if proc.poll() is not None and not stops:
            time.sleep(0.2)
            return bool(stops)
        time.sleep(0.3)
    return False


def main():
    server = HTTPServer(("127.0.0.1", 18199), MockGql)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = Path(tempfile.mkdtemp(prefix="deadman-harness-"))
    beat = tmp / "beat"

    # A: no beats at all, boot grace 3s -> stop within ~5s.
    p = run_watch({"DEADMAN_BOOT_GRACE_S": "3", "DEADMAN_BEAT_GRACE_S": "999"}, beat)
    assert wait_for_stop(p), "A: never-managed pod was not stopped after boot grace"
    assert stops[-1]["variables"]["input"]["podId"] == "podX", f"A: wrong podId: {stops[-1]}"
    p.wait(timeout=5)
    print("A ok: never-managed pod self-stopped after boot grace")

    # B: fresh beats keep it alive; when beats stop -> stop after beat grace.
    stops.clear()
    p = run_watch({"DEADMAN_BOOT_GRACE_S": "999", "DEADMAN_BEAT_GRACE_S": "3"}, beat)
    for _ in range(5):  # 5s of beats, tick is 1s
        beat.write_text(str(time.time()))
        time.sleep(1)
    assert not stops, "B: pod was stopped while heartbeats were fresh!"
    assert wait_for_stop(p), "B: silent pod was not stopped after beat grace"
    print("B ok: fresh beats held the stop; silence triggered it")

    # C: DEADMAN_DISABLE=1 -> exits immediately, no stop call.
    stops.clear()
    p = run_watch({"DEADMAN_DISABLE": "1"}, beat)
    assert p.wait(timeout=5) == 0, "C: disabled watchdog did not exit cleanly"
    assert not stops, "C: disabled watchdog issued a stop!"
    print("C ok: DEADMAN_DISABLE=1 is inert")

    print("deadman_watch harness: all scenarios passed")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"HARNESS FAILURE: {e}", file=sys.stderr)
        sys.exit(1)
