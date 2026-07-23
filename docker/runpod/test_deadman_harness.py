#!/usr/bin/env python3
"""Local harness for docker/runpod/deadman_watch.sh — NOT shipped.

Simulates RunPod's GraphQL endpoint and drives the watchdog through its paths:
  A) never-managed boot grace -> stop
  B) fresh beats hold the stop; silence -> stop
  C) DEADMAN_DISABLE=1 -> inert
  D) stale beat file from a previous boot -> boot grace honored (container
     disk survives stop/start, so /tmp is NOT fresh — codex finding)
  E) GraphQL error body containing the string "podStop" -> NOT treated as
     success (codex finding); the guard retries and exits only on a parsed,
     non-null podStop result
Exits non-zero on any failure.
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

GOOD = {"data": {"podStop": {"id": "podX", "desiredStatus": "EXITED"}}}
# GraphQL-over-HTTP still returns 200 on errors; the string "podStop" appears
# in BOTH errors[].path and a null data payload — grep would false-positive.
BAD = {"errors": [{"path": ["podStop"], "message": "boom"}], "data": {"podStop": None}}
response: dict = GOOD


class MockGql(BaseHTTPRequestHandler):
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        stops.append(body)
        out = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *a):
        pass


def sh_path(p) -> str:
    """Git Bash accepts C:/... but chokes on C:\\... — normalize separators."""
    return str(p).replace("\\", "/")


def run_watch(env_extra, beat_file, shim_dir):
    log_dir = Path(tempfile.mkdtemp(prefix="deadman-log-"))
    env = {
        **os.environ,  # full PATH — Git Bash's curl lives in /mingw64/bin
        # python3 shim first: the watchdog parses the podStop verdict with
        # python3; the pod image has it, this Windows test host may not. PATH is
        # inherited Windows-style (`;`) — MSYS converts it on bash startup.
        "PATH": str(shim_dir) + ";" + os.environ["PATH"],
        "RUNPOD_API_KEY": "test-key",
        "RUNPOD_POD_ID": "podX",
        "RUNPOD_GRAPHQL_ENDPOINT": "http://127.0.0.1:18199/graphql",
        "LOG_DIR": sh_path(log_dir),
        "DEADMAN_BEAT_FILE": sh_path(beat_file),
        "DEADMAN_TICK_S": "1",
        **env_extra,
    }
    return subprocess.Popen([BASH, sh_path(WATCH)], env=env), log_dir


def run_watch_tracked(*a):
    p, ld = run_watch(*a)
    PROCS.append(p)
    return p, ld


def wait_armed(log_dir: Path, timeout=15):
    """Wait for the watchdog's startup (incl. its beat-file reset) — beats sent
    before this line can be deleted by the startup rm, racing the scenario."""
    log = log_dir / "deadman.log"
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if "armed:" in log.read_text():
                return
        except FileNotFoundError:
            pass
        time.sleep(0.2)
    raise AssertionError("watchdog never logged 'armed:'")


def make_python3_shim(dir_: Path) -> None:
    """A `python3` that forwards to the host's python. MSYS2 marks files with a
    #! line as executable, which is exactly what the watchdog's `-x`/`command -v`
    checks need on Windows; on the pod, real python3 exists."""
    dir_.mkdir(parents=True, exist_ok=True)
    shim = dir_ / "python3"
    shim.write_text('#!/bin/sh\nexec python "$@"\n')


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


PROCS: list[subprocess.Popen] = []


def _cleanup():
    for p in PROCS:
        try:
            p.terminate()
        except Exception:
            pass


def main():
    global response
    server = HTTPServer(("127.0.0.1", 18199), MockGql)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    tmp = Path(tempfile.mkdtemp(prefix="deadman-harness-"))
    beat = tmp / "beat"
    shim = tmp / "shim"
    make_python3_shim(shim)

    # A: no beats at all, boot grace 3s -> stop within ~5s.
    p, ld = run_watch_tracked({"DEADMAN_BOOT_GRACE_S": "3", "DEADMAN_BEAT_GRACE_S": "999"}, beat, shim)
    wait_armed(ld)
    assert wait_for_stop(p), "A: never-managed pod was not stopped after boot grace"
    assert stops[-1]["variables"]["input"]["podId"] == "podX", f"A: wrong podId: {stops[-1]}"
    p.wait(timeout=5)
    print("A ok: never-managed pod self-stopped after boot grace")

    # B: fresh beats keep it alive; when beats stop -> stop after beat grace.
    stops.clear()
    p, ld = run_watch_tracked({"DEADMAN_BOOT_GRACE_S": "999", "DEADMAN_BEAT_GRACE_S": "3"}, beat, shim)
    wait_armed(ld)
    for _ in range(10):  # 5s of beats (2/s), tick is 1s
        beat.write_text(str(time.time()))
        time.sleep(0.5)
    assert not stops, "B: pod was stopped while heartbeats were fresh!"
    assert wait_for_stop(p), "B: silent pod was not stopped after beat grace"
    print("B ok: fresh beats held the stop; silence triggered it")

    # C: DEADMAN_DISABLE=1 -> exits immediately, no stop call.
    stops.clear()
    p, _ld = run_watch_tracked({"DEADMAN_DISABLE": "1"}, beat, shim)
    assert p.wait(timeout=5) == 0, "C: disabled watchdog did not exit cleanly"
    assert not stops, "C: disabled watchdog issued a stop!"
    print("C ok: DEADMAN_DISABLE=1 is inert")

    # D: a STALE beat file (mtime way past BEAT_GRACE) survives from a previous
    # boot. The watchdog must disregard it and grant the full boot grace — not
    # stop on the first tick.
    stops.clear()
    beat.write_text(str(time.time() - 3600))
    os.utime(beat, (time.time() - 3600, time.time() - 3600))
    p, ld = run_watch_tracked({"DEADMAN_BOOT_GRACE_S": "30", "DEADMAN_BEAT_GRACE_S": "3"}, beat, shim)
    wait_armed(ld)
    time.sleep(5)  # several ticks; old code stopped on tick 1
    assert not stops, "D: stale beat file from a previous boot triggered an immediate stop!"
    p.terminate()
    p.wait(timeout=5)
    print("D ok: pre-existing stale beat file disregarded — boot grace honored")

    # E: a GraphQL ERROR body still contains "podStop" — the watchdog must not
    # exit on it (the pod is still running!). It retries and exits only once a
    # parsed, non-null podStop result arrives.
    stops.clear()
    response = BAD
    p, ld = run_watch_tracked({"DEADMAN_BOOT_GRACE_S": "2", "DEADMAN_BEAT_GRACE_S": "999"}, tmp / "beat-e", shim)
    wait_armed(ld)
    assert wait_for_stop(p), "E: watchdog never attempted the stop"
    time.sleep(3)  # several retry cycles against the error body
    assert p.poll() is None, "E: watchdog exited on a GraphQL ERROR body — guard disarmed!"
    response = GOOD
    assert p.wait(timeout=10) == 0, "E: watchdog did not exit after a real stop was accepted"
    print("E ok: GraphQL error not mistaken for success; retried until parsed success")

    print("deadman_watch harness: all scenarios passed")


if __name__ == "__main__":
    try:
        main()
    except AssertionError as e:
        print(f"HARNESS FAILURE: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        _cleanup()
