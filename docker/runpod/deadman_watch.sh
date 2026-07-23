#!/usr/bin/env bash
# comfyui-mcp dead-man watchdog (pod side) — #269.
# =============================================================================
# Pods created via runpod_pod_create carry this loop + the heartbeat server
# (deadman_server.py). While comfyui-mcp minds the pod it heartbeats every
# poll; if the beats STOP (orchestrator crash, laptop closed, network gone),
# the in-process idle auto-stop is gone too — so this loop stops the pod
# ITSELF after the grace period instead of letting it bill forever.
#
#   * beat file present + older than DEADMAN_BEAT_GRACE_S  -> stop (lost manager)
#   * NO beat file at all after DEADMAN_BOOT_GRACE_S up    -> stop (never managed:
#     covers a create whose response was lost before anyone started watching)
#
# STOP (not terminate): the /workspace volume survives and the pod can be
# resumed later — same severity as the in-process idle auto-stop.
#
# Requires RUNPOD_POD_ID + DEADMAN_TOKEN in the pod env. The stop itself is
# authorized by RUNPOD_API_KEY — the POD-SCOPED key RunPod auto-injects into
# every pod (docs.runpod.io/pods/templates/environment-variables), NOT the
# owner's account key, which never leaves the orchestrator. Opt out of arming
# with `deadman:false` / RUNPOD_DEADMAN=0 at create time, or DEADMAN_DISABLE=1
# as a pod env any time. RUNPOD_GRAPHQL_ENDPOINT is overridable for tests.
# =============================================================================
set -uo pipefail

LOG_DIR="${LOG_DIR:-/var/log/comfyui-mcp}"
mkdir -p "${LOG_DIR}" 2>/dev/null || true
log() { echo "[comfyui-mcp/deadman] $(date -u +%H:%M:%S) $*" >> "${LOG_DIR}/deadman.log"; }

if [ "${DEADMAN_DISABLE:-0}" = "1" ]; then
  log "disabled (DEADMAN_DISABLE=1) — exiting"
  exit 0
fi
if [ -z "${RUNPOD_API_KEY:-}" ] || [ -z "${RUNPOD_POD_ID:-}" ]; then
  log "RUNPOD_API_KEY/RUNPOD_POD_ID not set (console-deployed pod?) — inert, exiting"
  exit 0
fi

BOOT_GRACE="${DEADMAN_BOOT_GRACE_S:-2700}"   # 45min: boot + connect window
BEAT_GRACE="${DEADMAN_BEAT_GRACE_S:-1200}"   # 20min: poll is 15s — huge slack
TICK="${DEADMAN_TICK_S:-60}"                 # check cadence (env for tests)
BEAT_FILE="${DEADMAN_BEAT_FILE:-/tmp/comfyui-mcp-deadman-beat}"
ENDPOINT="${RUNPOD_GRAPHQL_ENDPOINT:-https://api.runpod.io/graphql}"
START_TS="$(date +%s)"
# JSON parsing for the podStop verdict — grep can false-positive on
# {"data":{"podStop":null}} / errors[].path (codex finding); parse for real.
PYBIN="$([ -x "${COMFY_HOME:-/opt/ComfyUI}/venv/bin/python" ] && echo "${COMFY_HOME:-/opt/ComfyUI}/venv/bin/python" || command -v python3)"

# The container disk SURVIVES a pod stop/start, so a beat file from the previous
# boot can already be older than BEAT_GRACE — trust it and we'd stop the pod on
# the first tick instead of granting boot grace (codex finding). Always start
# from a clean slate: only beats fresher than THIS watchdog's start count.
rm -f "${BEAT_FILE}"

log "armed: boot grace ${BOOT_GRACE}s, beat grace ${BEAT_GRACE}s, tick ${TICK}s, beat file ${BEAT_FILE}"

# Exit 0 only on a PARSED, non-null podStop result with no GraphQL errors —
# anything else (HTTP error, {"podStop":null}, errors[].path) means the pod is
# still running and we must keep guarding (codex finding).
stop_accepted() {  # $1 = raw GraphQL response body
  [ -n "${PYBIN}" ] || return 1
  printf '%s' "$1" | "${PYBIN}" -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(1)
ps = (d.get("data") or {}).get("podStop")
sys.exit(0 if (not d.get("errors") and isinstance(ps, dict) and ps.get("id")) else 1)
'
}

stop_pod() {  # $1 = reason
  log "STOPPING POD ${RUNPOD_POD_ID}: $1"
  local out rc
  out="$(curl -sS -m 20 -X POST "${ENDPOINT}" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer ${RUNPOD_API_KEY}" \
    -d "{\"query\":\"mutation Stop(\$input: PodStopInput!) { podStop(input: \$input) { id desiredStatus } }\",\"variables\":{\"input\":{\"podId\":\"${RUNPOD_POD_ID}\"}}}" 2>&1)"
  rc=$?
  log "podStop rc=${rc}: ${out}"
  # Keep looping on failure (transient API blip must not disarm the guard);
  # once RunPod ACCEPTS the stop the pod goes down and takes us with it.
  if [ "${rc}" -eq 0 ] && stop_accepted "${out}"; then
    log "stop accepted — watchdog done"
    exit 0
  fi
  log "stop FAILED or unconfirmed — retrying next cycle (pod still billing!)"
}

while :; do
  sleep "${TICK}"
  now="$(date +%s)"
  if [ -f "${BEAT_FILE}" ]; then
    last_beat="$(stat -c %Y "${BEAT_FILE}" 2>/dev/null || echo "${now}")"
    age=$(( now - last_beat ))
    if [ "${age}" -gt "${BEAT_GRACE}" ]; then
      stop_pod "no heartbeat for ${age}s (> ${BEAT_GRACE}s) — manager is gone"
    fi
  else
    up=$(( now - START_TS ))
    if [ "${up}" -gt "${BOOT_GRACE}" ]; then
      stop_pod "no heartbeat received within ${BOOT_GRACE}s of boot — never managed"
    fi
  fi
done
