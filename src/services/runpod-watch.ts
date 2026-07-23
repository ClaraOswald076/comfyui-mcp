// Live RunPod pod status broadcast + idle auto-stop.
//
// Mirrors the queue-status / download-progress broadcasters: a poller turns the
// watched pod's live state into a `runpod_status` bridge frame so the panel and
// mobile control panels update in real time, change-only (an unchanged frame is
// not re-sent). RunPod's API is rate-limited, so we poll on a SLOW interval
// (default 15s) — unlike the 1s local ComfyUI queue tick.
//
// Idle auto-stop (gpu-cli parity): while the connected pod's ComfyUI queue is
// empty AND nothing is running, we accumulate idle time; once it crosses the
// configured timeout the pod is stopped automatically (pods bill per running
// GPU-second even when doing nothing). Off when idleStopMinutes <= 0.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { getPod, stopPod, comfyuiPortExposed, runpodProxyUrl, beatDeadman, type RunpodPod } from "./runpod-client.js";
import { logger } from "../utils/logger.js";

/** Wire shape of one live pod-status broadcast (panel/mobile control panels). */
export interface RunpodStatusFrame extends Record<string, unknown> {
  type: "runpod_status";
  /** Are we actively watching a pod? false → the rest is a cleared/idle frame. */
  watching: boolean;
  pod_id: string | null;
  name: string | null;
  /** RUNNING | EXITED | TERMINATED | … (null when not watching). */
  status: string | null;
  gpu: string | null;
  cost_per_hr: number | null;
  uptime_seconds: number | null;
  gpu_util: number | null;
  vram_util: number | null;
  /** The pod's ComfyUI proxy URL when running + exposed (else null). */
  comfyui_url: string | null;
  /** How long the pod's ComfyUI has been idle (queue empty, nothing running). */
  idle_seconds: number | null;
  /** Configured idle-stop timeout in minutes (null when disabled). */
  autostop_minutes: number | null;
  /** Seconds until auto-stop fires (null when disabled / not idle / not running). */
  autostop_in_seconds: number | null;
  /** True when a promised create-and-auto-connect did NOT happen (readiness
   *  timeout or superseded by a sibling winner). Decorates ONLY this pod's own
   *  status frames — failure ALERTS for other pods ride `runpod_alert` so they
   *  can't clobber the single watched-pod status slot (codex finding). */
  connect_failed?: boolean;
  /** The winning pod that superseded this one's auto-connect, when relevant. */
  superseded_by?: string;
}

/** A billing-relevant auto-connect FAILURE, on its own channel so it can't
 *  overwrite the watched pod's status in the single-slot panel store (codex
 *  finding). `resolved: true` retracts a previous alert (stopped/reconciled). */
export interface RunpodAlertFrame extends Record<string, unknown> {
  type: "runpod_alert";
  pod_id: string;
  /** "timeout" | "superseded" | "resolved" */
  reason: string;
  status: string;
  name?: string | null;
  gpu?: string | null;
  cost_per_hr?: number | null;
  uptime_seconds?: number | null;
  superseded_by?: string;
  resolved?: boolean;
}

const CLEARED_FRAME: RunpodStatusFrame = {
  type: "runpod_status",
  watching: false,
  pod_id: null,
  name: null,
  status: null,
  gpu: null,
  cost_per_hr: null,
  uptime_seconds: null,
  gpu_util: null,
  vram_util: null,
  comfyui_url: null,
  idle_seconds: null,
  autostop_minutes: null,
  autostop_in_seconds: null,
};

export interface RunpodWatcherDeps {
  /** Broadcast a frame to all panel/mobile tabs (the bridge's fire-and-forget push). */
  push: (frame: Record<string, unknown>) => void;
  /** True when the ACTIVE ComfyUI target's queue is empty and nothing is
   *  running. Receives the WATCHED pod id so the predicate can scope
   *  "busy training" to this exact pod (codex #274). */
  comfyuiIdle: (podId: string) => boolean;
  /** True only when comfyui-mcp is CURRENTLY rendering on this pod (its ComfyUI is
   *  the active target). Idle auto-stop applies ONLY then — a pod we merely watch
   *  (e.g. while it boots, before connect) must never be stopped on the LOCAL
   *  ComfyUI's idleness, which comfyuiIdle() reports when we haven't connected. */
  renderingOnPod: (podId: string) => boolean;
  /** The watched pod VANISHED (terminated externally) or was auto-stopped. The
   *  orchestrator uses this to fall back to the local target when the dead pod
   *  was the ACTIVE render target — otherwise renders keep failing against a
   *  dead proxy (#269 dead-target cleanup). Guarded there (not every watched
   *  pod is the render target). */
  onPodUnavailable?: (podId: string) => void;
  /** Idle-stop timeout in minutes; <= 0 disables auto-stop. */
  idleStopMinutes: number;
  /** Optional: persist unresolved connect-failure records here (per-port path)
   *  so an orchestrator self-restart doesn't lose billing warnings for pods
   *  that are still running (codex finding). Restored at creation; re-saved on
   *  every mutation. */
  persistPath?: string;
  /** Poll interval in ms (default 15000). */
  pollMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export interface RunpodWatcher {
  /** Start (or switch to) watching a pod — its status broadcasts live. */
  watch(podId: string): void;
  /** Stop watching; broadcasts a cleared frame. */
  unwatch(): void;
  /** The pod currently watched, or null. */
  watchedPodId(): string | null;
  /** The last frame sent (for seeding a tab that just connected). */
  current(): RunpodStatusFrame;
  /** Failure frames for pods whose auto-connect failed (timeout/superseded) —
   *  held SEPARATELY from the single watched frame so a routine poll of the
   *  watched pod can't overwrite the only warning (codex finding). Seeded to
   *  new tabs alongside current(). */
  failedFrames(): RunpodAlertFrame[];
  /** Record a failed auto-connect for a pod: the failure is stored (current()
 *  seeds it to new tabs) and `connect_failed` rides every later frame for that
 *  pod until it exits/vanishes (codex finding: a one-shot bridge push lets the
 *  only warning evaporate on the next routine poll). */
  markConnectFailed(podId: string, frame: RunpodAlertFrame): void;
  /** Clear a pod's failure record (e.g. after a successful runpod_pod_stop —
 *  otherwise an unwatched failed pod reports "still billing" forever). */
  clearConnectFailed(podId: string): void;
  /** Poll once now (also driven internally by the interval). Exposed for tests. */
  poll(): Promise<void>;
  /** Begin the poll interval. */
  start(): void;
  /** Stop the interval (does not unwatch). */
  stop(): void;
}

// ── Process-wide singleton ──────────────────────────────────────────────────
// The orchestrator owns the watcher (it has the bridge push + the ComfyUI queue
// monitor). The runpod_* tools run in the same process and reach it here; in a
// bare MCP-only setup (no orchestrator) it's null and watch/unwatch are no-ops
// (the one-shot runpod_pod_status tool still works).
let singleton: RunpodWatcher | null = null;
export function initRunpodWatcher(deps: RunpodWatcherDeps): RunpodWatcher {
  singleton?.stop();
  singleton = createRunpodWatcher(deps);
  singleton.start();
  return singleton;
}
export function getRunpodWatcher(): RunpodWatcher | null {
  return singleton;
}

export function createRunpodWatcher(deps: RunpodWatcherDeps): RunpodWatcher {
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? 15000;
  const idleStopMs = deps.idleStopMinutes > 0 ? deps.idleStopMinutes * 60_000 : 0;

  let podId: string | null = null;
  let last: RunpodStatusFrame = CLEARED_FRAME;
  let idleSinceMs: number | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let autoStopping = false;

  function pushIfChanged(frame: RunpodStatusFrame): void {
    if (JSON.stringify(frame) === JSON.stringify(last)) return;
    last = frame;
    deps.push(frame);
  }

  function frameFor(pod: RunpodPod, idleSeconds: number | null, autostopIn: number | null): RunpodStatusFrame {
    const g = pod.runtime?.gpus?.[0];
    return {
      type: "runpod_status",
      watching: true,
      pod_id: pod.id,
      name: pod.name,
      status: pod.desiredStatus,
      gpu: pod.machine?.gpuDisplayName ?? null,
      cost_per_hr: pod.costPerHr ?? null,
      uptime_seconds: pod.runtime?.uptimeInSeconds ?? null,
      gpu_util: g?.gpuUtilPercent ?? null,
      vram_util: g?.memoryUtilPercent ?? null,
      comfyui_url: comfyuiPortExposed(pod) ? runpodProxyUrl(pod.id) : null,
      idle_seconds: idleSeconds,
      autostop_minutes: idleStopMs > 0 ? deps.idleStopMinutes : null,
      autostop_in_seconds: autostopIn,
      // A failed auto-connect STICKS to this pod's frames until it exits or
      // vanishes (markConnectFailed) — the only warning must not evaporate on
      // the next routine uptime tick (codex finding).
      ...(connectFailedPods.has(pod.id) ? { connect_failed: true as const } : {}),
    };
  }

  /** Pods whose auto-connect failed (timeout/superseded) — failure sticks to
   *  their frames + the seed until they're gone. */
  const connectFailedPods = new Set<string>();
  /** Failure frames by pod — the seed channel, independent of `last`. */
  const failedById = new Map<string, RunpodAlertFrame>();
  /** Pods we OWE heartbeats — independent of the UI watch lifecycle (#269
   *  codex finding): runpod_unwatch / use_local only change what we DISPLAY;
   *  they must not cut a managed pod's only heartbeat and let its watchdog
   *  self-stop a workload the tools promised would keep running. Membership
   *  ends only when the pod exits/vanishes (poll or janitor discovers it) —
   *  or when the beat leash below decides there is no watchdog to feed. */
  const managedPods = new Set<string>();
  /** First failed-beat timestamp per managed pod. Pods that NEVER ack a beat
   *  (no watchdog — console deploys, deadman:false, pre-image pods) must not
   *  cost a janitor API call forever (codex r2): after 25min of straight
   *  failures (one grace longer than the pod's own beat grace — if it HAD a
   *  watchdog it has already self-stopped) the pod drops out of managed. */
  const managedBeatFailSince = new Map<string, number>();
  const MANAGED_BEAT_FAIL_DROP_MS = 25 * 60_000;
  async function beat(pod: RunpodPod): Promise<void> {
    if (await beatDeadman(pod)) {
      managedBeatFailSince.delete(pod.id);
      // A watchdog answered (only pods carrying OUR token can) — (re)manage
      // it. Leash recovery: a booting pod whose endpoint came up AFTER the
      // leash dropped it must not be left unfed (codex r3).
      managedPods.add(pod.id);
      return;
    }
    const since = managedBeatFailSince.get(pod.id) ?? now();
    managedBeatFailSince.set(pod.id, since);
    if (now() - since > MANAGED_BEAT_FAIL_DROP_MS) {
      managedBeatFailSince.delete(pod.id);
      managedPods.delete(pod.id);
      logger.info(`[runpod-watch] pod ${pod.id} never acked a heartbeat in 25min — no watchdog there; un-managing`);
    }
  }
  /** Clear + broadcast "resolved" — every removal path (janitor, stop, connect,
   *  vanish, terminal) goes through here so panels RETRACT the alert instead of
   *  keeping a stale billing warning (codex finding). */
  function clearFailure(id: string): void {
    const prior = failedById.get(id);
    connectFailedPods.delete(id);
    failedById.delete(id);
    if (prior) deps.push({ ...prior, reason: "resolved", resolved: true });
    persistFailures();
  }

  /** Persist unresolved failures across orchestrator self-restarts (pods keep
   *  billing while the process cycles — codex finding). Best-effort. */
  function persistFailures(): void {
    if (!deps.persistPath) return;
    try {
      mkdirSync(dirname(deps.persistPath), { recursive: true });
      if (failedById.size === 0) {
        rmSync(deps.persistPath, { force: true });
        return;
      }
      writeFileSync(deps.persistPath, JSON.stringify([...failedById.values()]));
    } catch {
      /* best-effort */
    }
  }
  // Restore failures recorded before a restart (not re-broadcast — new tabs
  // seed from failedFrames(); future polls re-decorate via frameFor).
  if (deps.persistPath) {
    try {
      const saved = JSON.parse(readFileSync(deps.persistPath, "utf-8")) as RunpodAlertFrame[];
      for (const f of saved) {
        if (f && typeof f.pod_id === "string") {
          failedById.set(f.pod_id, f);
          connectFailedPods.add(f.pod_id);
          managedPods.add(f.pod_id); // still-billing pod → still owed beats
        }
      }
    } catch {
      // no saved state
    }
  }
  /** Janitor: every ~10 polls, reconcile + HEARTBEAT managed pods we are NOT
   *  watching (their stop/vanish never reaches our poll paths — codex finding:
   *  an externally-stopped loser warned "still billing" forever; and a
   *  use_local'd / unwatched pod still needs its beats — codex #269). */
  let reconcileCounter = 0;
  async function reconcileManagedPods(): Promise<void> {
    for (const id of [...managedPods]) {
      if (id === podId) continue; // the watched pod's own poll paths handle it
      try {
        const pod = await getPod(id);
        if (!pod || pod.desiredStatus === "EXITED" || pod.desiredStatus === "TERMINATED" || pod.desiredStatus === "DEAD" || pod.desiredStatus === "PAUSED") {
          managedPods.delete(id); // gone → no longer ours to mind
          managedBeatFailSince.delete(id);
          // Same broadcast correction as clearConnectFailed — the janitor's
          // delete must not leave the stale failure on panels (codex).
          const prior = failedById.get(id);
          failedById.delete(id);
          connectFailedPods.delete(id);
          if (prior) {
            // Retract the alert with the TERMINAL status (the stale RUNNING
            // line must not live forever — codex finding).
            deps.push({ ...prior, reason: "resolved", resolved: true, status: pod?.desiredStatus ?? "TERMINATED" });
          }
        } else if (pod.desiredStatus === "RUNNING") {
          // Still-billing managed pod: feed its watchdog no matter what the UI
          // is watching (#269). Leashed — never-acking pods drop out (r2).
          void beat(pod);
        }
      } catch {
        // unknown — keep the warning (cost-safe direction)
      }
    }
    persistFailures();
  }

  // In-flight guard: on a hung network a slow poll must not stack up under the
  // interval — a tick that lands while the previous poll is still running JOINS
  // it (no second concurrent RunPod request) instead of starting an overlap.
  let inflight: Promise<void> | null = null;

  let reconcileInFlight = false;
  function poll(): Promise<void> {
    // Janitor tick BEFORE the target check: managed pods must reconcile (and
    // get their heartbeats) even with NO watched pod (codex finding — an
    // externally-stopped loser warned "still billing" forever; a use_local'd
    // pod still needs beats — #269). Cheap: only when managed pods exist, and
    // never overlapping (a slow sweep must not stack, codex r2).
    if (managedPods.size > 0 && !reconcileInFlight && ++reconcileCounter >= 10) {
      reconcileCounter = 0;
      reconcileInFlight = true;
      void reconcileManagedPods().finally(() => {
        reconcileInFlight = false;
      });
    }
    if (inflight) return inflight;
    inflight = pollOnce().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function pollOnce(): Promise<void> {
    // Capture the watched pod at poll START (the "generation"). A watch(other) or
    // unwatch() can land while we await getPod/stopPod below; if the target moved
    // off `target` before we resolve, this poll's result is STALE and must be
    // dropped — otherwise it would republish pod A's status (or null out podId)
    // after pod B was already selected, leaving B silently unwatched.
    const target = podId;
    if (!target || autoStopping) return;
    let pod: RunpodPod | null;
    try {
      pod = await getPod(target);
    } catch (err) {
      // Transient RunPod API blip — keep the last frame, try again next tick.
      logger.debug(`[runpod-watch] poll failed for ${target}: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (podId !== target) return; // target changed while awaiting → stale, drop
    if (!pod) {
      // Pod vanished (terminated) — stop watching, and tell the orchestrator:
      // if renders were targeting this pod's proxy, the active target is now
      // DEAD and must fall back to local (#269 dead-target cleanup).
      logger.info(`[runpod-watch] pod ${target} no longer exists — unwatching`);
      managedPods.delete(target); // gone → no longer owed beats (#269)
      managedBeatFailSince.delete(target);
      clearFailure(target);
      unwatch();
      deps.onPodUnavailable?.(target);
      return;
    }
    // A RETAINED pod still answers getPod after being stopped externally
    // (console / another process): desiredStatus EXITED/TERMINATED/DEAD with
    // runtime null. Same dead-target cleanup as the vanish path — otherwise
    // the dead proxy stays the active render target forever (codex finding).
    // Booting states (CREATED/RESTARTING) merely keep watching.
    if (pod.desiredStatus === "EXITED" || pod.desiredStatus === "TERMINATED" || pod.desiredStatus === "DEAD" || pod.desiredStatus === "PAUSED") {
      logger.info(`[runpod-watch] pod ${target} is ${pod.desiredStatus} — unwatching`);
      // Clear the failure BEFORE the terminal frame is cached as `last` —
      // otherwise current() seeds a stale connect_failed flag to new tabs even
      // though the alert was resolved (codex finding).
      clearFailure(target);
      pushIfChanged(frameFor(pod, null, null));
      const goneTarget = target;
      podId = null;
      idleSinceMs = null;
      managedPods.delete(goneTarget); // terminal → no longer owed beats (#269)
      managedBeatFailSince.delete(goneTarget);
      deps.onPodUnavailable?.(goneTarget);
      return;
    }

    // Idle tracking: only accrue idle time (and thus auto-stop) when comfyui-mcp
    // is ACTUALLY RENDERING ON THIS POD. A watched-but-unconnected pod (e.g. one
    // still booting) must never be stopped on the LOCAL ComfyUI's idleness —
    // comfyuiIdle() reports the active target, which is local until we connect.
    const running = pod.desiredStatus === "RUNNING" && !!pod.runtime;
    let idleSeconds: number | null = null;
    let autostopIn: number | null = null;
    if (running && deps.renderingOnPod(target) && deps.comfyuiIdle(target)) {
      if (idleSinceMs == null) idleSinceMs = now();
      idleSeconds = Math.floor((now() - idleSinceMs) / 1000);
      if (idleStopMs > 0) {
        const remainMs = idleStopMs - (now() - idleSinceMs);
        autostopIn = Math.max(0, Math.ceil(remainMs / 1000));
        if (remainMs <= 0) {
          // Fire auto-stop once; broadcast the reason so the UI can show it.
          autoStopping = true;
          logger.info(`[runpod-watch] pod ${target} idle ${idleSeconds}s ≥ ${deps.idleStopMinutes}m — auto-stopping to save cost`);
          try {
            await stopPod(target);
          } catch (err) {
            // MONEY SAFETY: the stop FAILED — the pod is still RUNNING and still
            // BILLING. Do NOT pretend it exited and do NOT stop watching: broadcast
            // the TRUE status with an autostop_failed hint so the UI can warn, keep
            // the idle clock (remainMs stays ≤ 0), and retry the stop next tick.
            logger.warn(`[runpod-watch] auto-stop of ${target} FAILED — pod still running/billing, will retry next tick: ${err instanceof Error ? err.message : err}`);
            autoStopping = false;
            if (podId === target) pushIfChanged({ ...frameFor(pod, idleSeconds, 0), autostop_failed: true });
            return;
          }
          autoStopping = false;
          if (podId !== target) return; // switched target mid-stop → don't touch B
          const stopped: RunpodStatusFrame = {
            ...frameFor(pod, idleSeconds, 0),
            status: "EXITED",
            autostop_in_seconds: 0,
          };
          pushIfChanged(stopped);
          // Stop watching WITHOUT clearing — the panel keeps showing the pod as
          // EXITED (so the user can restart it) instead of the card vanishing.
          const goneTarget = target;
          podId = null;
          idleSinceMs = null;
          managedPods.delete(goneTarget); // stopped → no longer owed beats (#269)
          managedBeatFailSince.delete(goneTarget);
          // Same dead-target cleanup as the vanish path: if renders pointed at
          // this pod, fall back to local (#269).
          deps.onPodUnavailable?.(goneTarget);
          return;
        }
      }
    } else {
      idleSinceMs = null; // active or not-running → reset the idle clock
    }

    // Dead-man heartbeat (#269): while we manage this pod, feed its pod-side
    // watchdog — if this process dies, beats stop and the pod stops ITSELF.
    // Best-effort (own timeout, errors swallowed): never breaks the status path.
    if (running) void beat(pod);

    pushIfChanged(frameFor(pod, idleSeconds, autostopIn));
  }

  function watch(id: string): void {
    const switching = podId !== id;
    podId = id;
    idleSinceMs = null;
    managedPods.add(id); // we owe it heartbeats until it exits/vanishes (#269)
    // A SUCCESSFUL connect (we're now rendering on this pod) resolves its past
    // failure — but a watch-ONLY flow (boot monitor, runpod_watch) must not
    // erase a persisted warning for an unconnected, still-billing pod (codex
    // finding). clearFailure broadcasts the "resolved" alert.
    if (deps.renderingOnPod(id)) clearFailure(id);
    // Kick an immediate poll so the panel doesn't wait a full interval. If a poll
    // for the PREVIOUS target is still in flight, don't overlap it — chain a fresh
    // poll after it settles (that stale poll drops its own result via the
    // generation guard), so the NEW target is polled promptly and correctly.
    if (inflight) {
      if (switching) void inflight.then(() => { if (podId === id) void poll(); });
    } else {
      void poll();
    }
  }

  function unwatch(): void {
    podId = null;
    idleSinceMs = null;
    pushIfChanged(CLEARED_FRAME);
  }

  return {
    watch,
    unwatch,
    watchedPodId: () => podId,
    current: () => last,
    markConnectFailed(id, frame) {
      // Record the failure: stored SEPARATELY from `last` (a routine poll of
      // the watched pod must not overwrite the only warning — codex finding),
      // broadcast WITHOUT touching the watched-frame cache (a new tab must
      // still get the watched pod's real status from current(), not the
      // loser's failure — codex finding), and stuck to this pod's later
      // frames (frameFor) until it exits/vanishes or is intentionally
      // reconnected (watch()).
      connectFailedPods.add(id);
      failedById.set(id, frame);
      managedPods.add(id); // failed-connect pod is still OURS (billing) — beats
      deps.push(frame);
      persistFailures();
    },
    failedFrames: () => [...failedById.values()],
    clearConnectFailed: clearFailure,
    poll,
    start() {
      if (timer) return;
      timer = setInterval(() => void poll(), pollMs);
      if (typeof timer === "object" && timer && "unref" in timer) (timer as { unref: () => void }).unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}
