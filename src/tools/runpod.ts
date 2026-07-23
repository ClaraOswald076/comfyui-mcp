import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { setComfyuiTarget, getLocalComfyuiUrl, getComfyUIBaseUrl } from "../config.js";
import { resetClient } from "../comfyui/client.js";
import { errorToToolResult } from "../utils/errors.js";
import {
  getPod,
  listPods,
  resumePod,
  stopPod,
  createPod,
  comfyuiPortExposed,
  runpodProxyUrl,
  runpodDeployLink,
  RUNPOD_COMFYUI_PORT,
  RUNPOD_DEFAULT_GPU_TYPES,
  GPU_CLI_CREDIT,
  type RunpodPod,
} from "../services/runpod-client.js";
import { getRunpodWatcher } from "../services/runpod-watch.js";
import { requestTargetChange, awaitTargetApplied, progressEnabled } from "../services/download-progress.js";

/** Retarget comfyui-mcp back to the local ComfyUI (shared by stop + use_local).
 *  Returns { url, applied } for display (url null when the channel is down).
 *  applied=false means the orchestrator SKIPPED the guarded switch (another
 *  tab/pod owns the target now) — the caller must not claim a local switch
 *  (codex finding). */
async function retargetLocal(condOnPodId?: string): Promise<{ url: string | null; applied: boolean }> {
  if (progressEnabled()) {
    // condOnPodId: the stop-fallback — fall back ONLY if the orchestrator is
    // really on that pod (a stale child may lag a newer target, codex). The
    // unwatch is SCOPED to the stopped pod the same way (an unrelated watched
    // pod must survive — codex finding).
    const reqFile = requestTargetChange({ local: true, unwatch: true, wantAck: true, expectedCurrentUrl: getComfyUIBaseUrl(), ...(condOnPodId ? { onlyIfTarget: condOnPodId, unwatchPodId: condOnPodId } : {}) });
    if (!reqFile) return { url: null, applied: false };
    const ack = await awaitTargetApplied(reqFile);
    if (ack) {
      // Align THIS child's config to the AUTHORITATIVE target either way
      // (codex finding: a guarded skip left the child on a dead pod for the
      // rest of the turn). `applied` only narrates whether the requested
      // local switch actually happened.
      setComfyuiTarget(ack.url);
      resetClient();
    }
    return { url: ack?.url ?? null, applied: ack?.applied ?? false };
  }
  const url = getLocalComfyuiUrl();
  setComfyuiTarget(url);
  resetClient();
  // In-process: the direct path did everything (pending clears ride the target
  // event; failure clears are direct calls). Do NOT also replay a local
  // request through the channel — same stale-overwrite race (codex finding).
  return { url, applied: true };
}

/** Human-friendly uptime. */
function fmtUptime(sec: number | null | undefined): string {
  if (!sec || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** One-line summary of a pod's live state (shared by status/list/troubleshoot). */
function summarizePod(pod: RunpodPod): string[] {
  const lines: string[] = [];
  lines.push(`**${pod.name || "(unnamed)"}** \`${pod.id}\` — **${pod.desiredStatus}**`);
  if (pod.machine?.gpuDisplayName) lines.push(`GPU: ${pod.machine.gpuDisplayName}`);
  if (pod.costPerHr != null) lines.push(`Cost: $${pod.costPerHr.toFixed(3)}/hr`);
  if (pod.runtime) {
    lines.push(`Uptime: ${fmtUptime(pod.runtime.uptimeInSeconds)}`);
    const g = pod.runtime.gpus?.[0];
    // Telemetry leaves are nullable in RunPod's schema (#269 r2) — render
    // each only when actually reported, never a literal "null%".
    if (g) {
      const util = g.gpuUtilPercent != null ? `GPU util: ${g.gpuUtilPercent}%` : "";
      const vram = g.memoryUtilPercent != null ? `VRAM: ${g.memoryUtilPercent}%` : "";
      const both = [util, vram].filter(Boolean).join(" · ");
      if (both) lines.push(both);
    }
  }
  if (comfyuiPortExposed(pod)) {
    lines.push(`ComfyUI: ${runpodProxyUrl(pod.id)} (connect with runpod_pod_connect)`);
  }
  return lines;
}

/** Fetch a URL with a timeout — for probing whether the pod's ComfyUI answers. */
async function probe(url: string, timeoutMs = 8000): Promise<{ ok: boolean; status?: number; error?: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

export function registerRunpodTools(server: McpServer): void {
  // ── STATUS ─────────────────────────────────────────────────────────────────
  server.tool(
    "runpod_pod_status",
    "Get the live state of a RunPod pod by ID: its desired status (RUNNING / EXITED / TERMINATED), GPU, uptime, $/hr cost, GPU/VRAM utilization, and — when it's running and exposes ComfyUI — the proxy URL to connect to. Call this first to see what state a pod is in before starting/stopping/connecting. Read-only.",
    {
      pod_id: z.string().describe("The RunPod pod ID (from console.runpod.io, or runpod_list_pods)."),
    },
    async (args) => {
      try {
        const pod = await getPod(args.pod_id);
        if (!pod) {
          return { content: [{ type: "text", text: `No pod \`${args.pod_id}\` on this RunPod account. Check the ID (runpod_list_pods lists yours), or create one — runpod_deploy_link.` }] };
        }
        return { content: [{ type: "text", text: summarizePod(pod).join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── LIST ─────────────────────────────────────────────────────────────────
  server.tool(
    "runpod_list_pods",
    "List all RunPod pods on the account (id, name, status, GPU, cost). Use when the user hasn't given a pod ID, or to find the one they mean. If the account has no pods, tell the user to create one and share runpod_deploy_link. Read-only.",
    {},
    async () => {
      try {
        const pods = await listPods();
        if (pods.length === 0) {
          return { content: [{ type: "text", text: `No pods on this RunPod account. Create one with the referral deploy link (runpod_deploy_link) so your spend credits us.` }] };
        }
        const text = pods
          .map((p) => `- **${p.name || "(unnamed)"}** \`${p.id}\` — ${p.desiredStatus}${p.machine?.gpuDisplayName ? ` · ${p.machine.gpuDisplayName}` : ""}${p.costPerHr != null ? ` · $${p.costPerHr.toFixed(3)}/hr` : ""}`)
          .join("\n");
        return { content: [{ type: "text", text: `${pods.length} pod(s):\n${text}` }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── START ─────────────────────────────────────────────────────────────────
  server.tool(
    "runpod_pod_start",
    "Start (resume) a stopped/exited RunPod pod by ID — RunPod re-attaches a GPU and boots the container (billing resumes). Returns immediately once RunPod accepts the resume; the pod then takes ~30-90s to become reachable, so follow with runpod_pod_status (or runpod_pod_connect, which waits) rather than assuming it's instantly up. If RunPod can't allocate the requested GPU it errors — try a different gpu_count or GPU type in the console.",
    {
      pod_id: z.string().describe("The RunPod pod ID to start."),
      gpu_count: z.number().int().min(1).max(8).optional().describe("GPUs to attach on resume (default 1)."),
    },
    async (args) => {
      try {
        const r = await resumePod(args.pod_id, args.gpu_count ?? 1);
        return { content: [{ type: "text", text: `Started pod \`${r.id}\` → **${r.desiredStatus}**. It needs ~30-90s to boot ComfyUI — check runpod_pod_status, then runpod_pod_connect once it's RUNNING.` }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── STOP ─────────────────────────────────────────────────────────────────
  server.tool(
    "runpod_pod_stop",
    "Stop a running RunPod pod by ID — releases the GPU and stops GPU-time billing while KEEPING the pod and its disk (so you can start it again later). Use when the user is done rendering. Does NOT terminate/delete the pod (that's a console action). Confirm with the user before stopping a pod that has work in progress.",
    {
      pod_id: z.string().describe("The RunPod pod ID to stop."),
    },
    async (args) => {
      try {
        const w = getRunpodWatcher();
        const r = await stopPod(args.pod_id);
        // Clear any recorded auto-connect failure for this pod — it's stopped
        // now, so "still billing" reports must stop too. Both locally (when
        // the watcher exists) AND through the control channel (spawned-child
        // case, where it doesn't — codex finding).
        getRunpodWatcher()?.clearConnectFailed(args.pod_id);
        requestTargetChange({ stoppedPodId: args.pod_id });
        // Unwatch ONLY after the stop succeeded — clearing it first would
        // leave a possibly-still-running pod unwatched and billing when the
        // API call times out or is rejected (codex finding).
        if (w?.watchedPodId() === args.pod_id) w?.unwatch();
        // If comfyui-mcp was pointed at THIS pod, its proxy URL is now dead —
        // fall back to the local ComfyUI so rendering keeps working (the swap
        // half of the local⇄pod flow). The ORCHESTRATOR decides whether its
        // authoritative target matches (onlyIfTarget) — a spawned child's own
        // base URL can be a turn stale (codex finding: stopping B while the
        // child lagged on A left the orchestrator on B's dead proxy).
        let localNote = "";
        if (progressEnabled()) {
          const r = await retargetLocal(args.pod_id);
          localNote = r.applied && r.url
            ? ` comfyui-mcp switched back to local ComfyUI (${r.url}).`
            : r.applied
              ? " comfyui-mcp is switching back to the local ComfyUI (the orchestrator resolves the target)."
              : " the session's active target moved to another pod in the meantime — leaving it there.";
        } else if (getComfyUIBaseUrl().includes(args.pod_id)) {
          // In-process: this IS the orchestrator — the local check is current.
          const r = await retargetLocal(args.pod_id);
          localNote = r.applied && r.url ? ` comfyui-mcp switched back to local ComfyUI (${r.url}).` : "";
        }
        return { content: [{ type: "text", text: `Stopped pod \`${r.id}\` → **${r.desiredStatus}**. GPU released; disk kept.${localNote} Start it again with runpod_pod_start.` }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── CREATE (deploy our template via the API — referral-earning) ───────────
  server.tool(
    "runpod_pod_create",
    "Deploy a BRAND-NEW RunPod pod from our comfyui-mcp template (image with the panel + Manager + our nodes preinstalled), then it can be started/connected like any pod. One-tap alternative to the console deploy link for a user who already has a RunPod account + API key. Because our template is used, the agent can install the user's exact custom nodes/LoRAs + download models on it → full canvas parity. Tries several GPU types until one has capacity (on-demand availability fluctuates). NOTE: this bills GPU-time as soon as the pod boots — confirm with the user first, and stop it (runpod_pod_stop) when done. Created pods carry a DEAD-MAN SWITCH: if comfyui-mcp stops minding the pod (crash/offline), the pod STOPS ITSELF after a grace period so it can't bill forever — it uses the pod-scoped key RunPod auto-injects, so your account key never leaves this machine (disable with deadman:false). For onboarding a NEW RunPod user, prefer runpod_deploy_link so their signup credits our referral.",
    {
      name: z.string().optional().describe("Pod name (default 'comfyui-mcp')."),
      gpu_type: z.string().optional().describe(`GPU type to prefer, e.g. "NVIDIA GeForce RTX 4090". Default tries: ${RUNPOD_DEFAULT_GPU_TYPES.join(", ")}.`),
      cloud_type: z.enum(["COMMUNITY", "SECURE"]).optional().describe("COMMUNITY (cheaper, default) or SECURE."),
      connect: z.boolean().optional().describe("Auto-connect when booted: the ORCHESTRATOR waits for ComfyUI to answer (1-3min), then retargets + watches — this call returns immediately (default false: deploy only; connect later with runpod_pod_connect)."),
      deadman: z.boolean().optional().describe("Arm the pod-side dead-man watchdog (default true for OUR stock template): the pod STOPS ITSELF if comfyui-mcp's heartbeats stop (process crash/offline — boot grace ~45min, then ~20min without beats). Uses the pod-scoped API key RunPod auto-injects into every pod — your account key never leaves this machine. false deploys without the watchdog. With a custom template (RUNPOD_TEMPLATE_ID) the default is OFF — pass true only if that image ships our watchdog."),
    },
    async (args) => {
      try {
        const pod = await createPod({
          name: args.name,
          gpuTypeIds: args.gpu_type ? [args.gpu_type] : undefined,
          cloudType: args.cloud_type,
          deadman: args.deadman,
        });
        const cost = pod.costPerHr != null ? ` at $${pod.costPerHr.toFixed(3)}/hr` : "";
        const gpu = pod.machine?.gpuDisplayName ? ` on ${pod.machine.gpuDisplayName}` : "";
        // Broadcast its status to the control panels while it boots — including
        // the spawned-child case: a watch-ONLY control request (no retarget yet)
        // so the orchestrator starts broadcasting immediately, not just after
        // the readiness wait (codex finding: boot-time + timeout path were
        // unwatched while the result claimed live status). NEVER displace an
        // ACTIVE render target's watch for this — the current pod's idle
        // auto-stop / dead-target cleanup is its billing guard (codex). Track
        // whether it actually GOT watched so the result doesn't claim otherwise
        // (codex finding: guarded-out creates still said "status broadcasting").
        let watchedNow = false;
        let activeOtherPod: string | null = null;
        if (getRunpodWatcher()) {
          const w = getRunpodWatcher()!;
          const cur = w.watchedPodId();
          const curIsActiveTarget = !!cur && getComfyUIBaseUrl().includes(cur);
          if (curIsActiveTarget && cur !== pod.id) activeOtherPod = cur;
          if (!activeOtherPod) {
            w.watch(pod.id);
            watchedNow = true;
          }
        }
        // Queue the orchestrator watch ONLY when this process has no watcher
        // (spawned child) — in-process the direct watch above already applied
        // synchronously, and a delayed duplicate could re-watch after a user's
        // unwatch; the wantAck would also never be consumed (codex finding).
        const watchReqFile = getRunpodWatcher() ? null : requestTargetChange({ watchPodId: pod.id, wantAck: true });
        // In the spawned child the watcher is null — confirm the orchestrator
        // actually accepted the watch (its active-target guard may REFUSE it
        // to protect the current pod; claiming otherwise would lie — codex).
        let watchedEffectively = watchedNow;
        let watchUnknown = false;
        if (!watchedEffectively && watchReqFile) {
          const ack = await awaitTargetApplied(watchReqFile, 3_000);
          if (ack) watchedEffectively = ack.applied;
          else watchUnknown = true; // NO ack: unconfirmed — never claim watched (codex)
        }
        const watchNote = watchedNow
          ? "Live status is broadcasting to the control panel (idle auto-stop active)."
          : watchedEffectively
            ? "Live status broadcasts on the orchestrator's next poll (idle auto-stop active)."
            : watchUnknown
              ? `Live status was requested but is UNCONFIRMED (no orchestrator ack yet) — check \`${pod.id}\` with runpod_pod_status in a moment; idle auto-stop may not be armed yet.`
              : `NOTE: still rendering on the current pod — \`${pod.id}\` is booting UNWATCHED (its idle auto-stop is NOT armed) so the active pod keeps its billing guard; it gets watched when it becomes the target — or watch it yourself with runpod_watch once the current pod is free.`;
        if (args.connect) {
          // connect: true actually connects (#269 — it was a documented no-op),
          // but the WAIT lives in the orchestrator, not here: an MCP tool call
          // dies at the SDK's 60s default timeout while a pod takes 1-3min to
          // boot (codex finding). Ask the orchestrator to probe until ready,
          // then retarget+watch; this call returns immediately. NO channel
          // (headless MCP server, no progress dir) → say so honestly instead of
          // promising an auto-connect nothing will perform (codex).
          const url = runpodProxyUrl(pod.id);
          const reqFile = requestTargetChange({ watchPodId: pod.id, connectWhenReady: { url, podId: pod.id }, expectedCurrentUrl: getComfyUIBaseUrl(), wantAck: true });
          if (!reqFile) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `🚀 Deployed pod \`${pod.id}\` (${pod.name || "comfyui-mcp"})${gpu}${cost}. It's booting (~1-3min) — auto-connect AND live status/idle auto-stop are unavailable in this mode (no panel orchestrator), so connect once it's up with runpod_pod_connect \`${pod.id}\`, watch it with runpod_pod_status, and stop it with runpod_pod_stop when done to end billing.\n\n${GPU_CLI_CREDIT}`,
                },
              ],
            };
          }
          // Confirm the registration actually landed (a newer target choice
          // can generation-reject it — codex finding: the tool still promised
          // auto-connect while no pending entry existed). A MISSING ack (e.g.
          // the channel dir rotating under a restart) is UNCONFIRMED, not a
          // promise (codex finding).
          const regAck = await awaitTargetApplied(reqFile, 4_000);
          if (!regAck) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `🚀 Deployed pod \`${pod.id}\` (${pod.name || "comfyui-mcp"})${gpu}${cost}. It's booting — auto-connect is UNCONFIRMED (the orchestrator hasn't acked the registration). Check \`${pod.id}\` with runpod_pod_status in a moment, or connect manually with runpod_pod_connect when it's ready. Stop it with runpod_pod_stop when done to end billing.\n\n${GPU_CLI_CREDIT}`,
                },
              ],
            };
          }
          if (!regAck.applied) {
            return {
              content: [
                {
                  type: "text",
                  text:
                    `🚀 Deployed pod \`${pod.id}\` (${pod.name || "comfyui-mcp"})${gpu}${cost}. It's booting, but auto-connect was SKIPPED — a newer target choice won the race. Connect manually when ready: runpod_pod_connect \`${pod.id}\`. Stop it with runpod_pod_stop when done to end billing.\n\n${GPU_CLI_CREDIT}`,
                },
              ],
            };
          }
          return {
            content: [
              {
                type: "text",
                text:
                  `🚀 Deployed pod \`${pod.id}\` (${pod.name || "comfyui-mcp"})${gpu}${cost}. It's booting — the orchestrator will AUTO-CONNECT when ComfyUI answers (usually 1-3min; it gives up honestly after 8). ` +
                  `${watchNote} Stop it with runpod_pod_stop when done to end billing.\n\n${GPU_CLI_CREDIT}`,
              },
            ],
          };
        }
        return {
          content: [
            {
              type: "text",
              text:
                `🚀 Deployed pod \`${pod.id}\` (${pod.name || "comfyui-mcp"})${gpu}${cost}. ` +
                `It's booting now — ComfyUI takes ~1-3min to come up (model volume warm-up on first boot). ` +
                `Watch it with runpod_pod_status, then runpod_pod_connect \`${pod.id}\` once ready. ` +
                `${watchNote} ` +
                `Stop it with runpod_pod_stop when done to end billing.\n\n${GPU_CLI_CREDIT}`,
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── USE LOCAL (switch renders back to this machine) ───────────────────────
  server.tool(
    "runpod_use_local",
    "Switch comfyui-mcp back to the LOCAL ComfyUI on this machine (the 'Local' half of the local⇄pod switch) — retargets rendering to loopback so generate/workflows run on the local GPU again. Stops broadcasting the pod's status but does NOT stop the pod itself (use runpod_pod_stop to end billing). Use when the user wants to render locally again after working on a pod.",
    {},
    async () => {
      try {
        const w = getRunpodWatcher();
        const was = w?.watchedPodId();
        w?.unwatch();
        const r = await retargetLocal();
        return {
          content: [
            {
              type: "text",
              text:
                (r.applied && r.url
                  ? `✅ comfyui-mcp now targets the local ComfyUI (${r.url}). Renders run on this machine.`
                  : r.applied
                    ? `✅ comfyui-mcp is switching back to the local ComfyUI — the orchestrator resolves its remembered target and un-watches the pod.`
                    : `⚠️ The local switch was skipped — the active target changed in the meantime (check runpod_status / the host pill).`) +
                (was ? ` Pod \`${was}\` is still running — stop it with runpod_pod_stop to end billing, or reconnect with runpod_pod_connect.` : ""),
            },
          ],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── WATCH / UNWATCH (live status broadcast + idle auto-stop) ──────────────
  server.tool(
    "runpod_watch",
    "Start broadcasting a pod's LIVE status to the control panel (desktop + mobile) — status, GPU/VRAM utilization, uptime, $/hr, and an idle-auto-stop countdown — refreshed every ~15s. runpod_pod_connect already starts this for the pod it connects to; call this to watch a pod WITHOUT retargeting comfyui-mcp at it (e.g. monitor a pod that's still booting). While watched, if the pod's ComfyUI sits idle past the configured timeout it is auto-stopped to save cost.",
    {
      pod_id: z.string().describe("The RunPod pod ID to watch."),
    },
    async (args) => {
      try {
        const w = getRunpodWatcher();
        if (!w) return { content: [{ type: "text", text: `Live status watch isn't available (no orchestrator/panel connected). runpod_pod_status gives a one-shot snapshot.` }] };
        // Validate the pod exists before watching, for a clear error.
        const pod = await getPod(args.pod_id);
        if (!pod) return { content: [{ type: "text", text: `No pod \`${args.pod_id}\` on this account (runpod_list_pods).` }] };
        w.watch(args.pod_id);
        return { content: [{ type: "text", text: `Now broadcasting live status for pod \`${args.pod_id}\` to the control panel (idle auto-stop active). Stop with runpod_unwatch.` }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  server.tool(
    "runpod_unwatch",
    "Stop broadcasting a pod's live status to the control panel (does NOT stop the pod itself — use runpod_pod_stop for that). Also disables idle auto-stop for it.",
    {},
    async () => {
      const w = getRunpodWatcher();
      const was = w?.watchedPodId();
      w?.unwatch();
      return { content: [{ type: "text", text: was ? `Stopped watching pod \`${was}\`. The pod is still running — runpod_pod_stop to stop it.` : `No pod was being watched.` }] };
    },
  );

  // ── TROUBLESHOOT ──────────────────────────────────────────────────────────
  server.tool(
    "runpod_pod_troubleshoot",
    "Diagnose why a RunPod pod isn't usable — call this when the pod 'won't connect', ComfyUI is unreachable, or a render can't reach the pod. Checks: does the pod exist, is it RUNNING (vs stopped/exited — then start it), is a GPU attached, is ComfyUI's port exposed as an HTTP proxy port, and does ComfyUI actually ANSWER at its proxy URL (probes /system_stats). Returns the specific blocker and the next step. Read-only.",
    {
      pod_id: z.string().describe("The RunPod pod ID to troubleshoot."),
    },
    async (args) => {
      try {
        const pod = await getPod(args.pod_id);
        if (!pod) {
          return { content: [{ type: "text", text: `❌ No pod \`${args.pod_id}\` on this account. Wrong ID (see runpod_list_pods) or it was terminated — create a new one via runpod_deploy_link.` }] };
        }
        const lines: string[] = [...summarizePod(pod), ""];
        if (pod.desiredStatus !== "RUNNING") {
          lines.push(`❌ Pod is **${pod.desiredStatus}**, not RUNNING. → Start it with runpod_pod_start, then re-check.`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        if (!pod.runtime) {
          lines.push(`⏳ Pod is RUNNING but has no runtime yet — it's still booting (GPU attaching / container starting). Wait ~30-60s and re-check.`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        if (!comfyuiPortExposed(pod)) {
          lines.push(`❌ Port ${RUNPOD_COMFYUI_PORT} is not exposed as an HTTP port on this pod, so ComfyUI can't be reached through RunPod's proxy. → Add ${RUNPOD_COMFYUI_PORT} to the pod/template's HTTP ports in the console, then restart the pod.`);
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }
        const url = runpodProxyUrl(pod.id);
        const p = await probe(`${url}/system_stats`);
        if (p.ok) {
          lines.push(`✅ ComfyUI is answering at ${url}. The pod is healthy — connect with runpod_pod_connect.`);
        } else {
          lines.push(`❌ Port ${RUNPOD_COMFYUI_PORT} is exposed but ComfyUI did not answer at ${url}/system_stats (${p.status ?? p.error}). Likely still starting, or ComfyUI crashed on boot. → Wait ~30s and re-check; if it persists, view the pod's logs in the console (a missing model/custom node can abort ComfyUI on startup).`);
        }
        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── CONNECT (retarget comfyui-mcp at the pod) ────────────────────────────
  server.tool(
    "runpod_pod_connect",
    "Connect comfyui-mcp to a RunPod pod's ComfyUI so ALL the other comfyui tools (generate, workflows, models, panel, …) run against that pod. Give it a pod ID: it verifies the pod is RUNNING with ComfyUI reachable, resolves the pod's proxy URL, and retargets this orchestrator's ComfyUI client to it. If the pod isn't ready it tells you what's missing (run runpod_pod_start / runpod_pod_troubleshoot first). This is the 'live connection' — after it succeeds, the rest of the session talks to the pod.",
    {
      pod_id: z.string().describe("The RunPod pod ID to connect to."),
    },
    async (args) => {
      try {
        const pod = await getPod(args.pod_id);
        if (!pod) return { content: [{ type: "text", text: `No pod \`${args.pod_id}\` on this account (runpod_list_pods).` }] };
        if (pod.desiredStatus !== "RUNNING") {
          return { content: [{ type: "text", text: `Pod \`${pod.id}\` is **${pod.desiredStatus}**, not RUNNING — start it first (runpod_pod_start), then connect.` }] };
        }
        if (!comfyuiPortExposed(pod)) {
          return { content: [{ type: "text", text: `Pod \`${pod.id}\` is RUNNING but doesn't expose ComfyUI on port ${RUNPOD_COMFYUI_PORT} — run runpod_pod_troubleshoot for the fix.` }] };
        }
        // The generation guard needs the PRE-retarget view (the target I
        // believe the orchestrator is on NOW) — capturing it after
        // setComfyuiTarget would stamp the NEW url and the orchestrator would
        // reject its own legitimate request every time (codex finding).
        const preRetargetUrl = getComfyUIBaseUrl();
        const url = runpodProxyUrl(pod.id);
        const probeRes = await probe(`${url}/system_stats`);
        if (!probeRes.ok) {
          return { content: [{ type: "text", text: `Pod \`${pod.id}\` exposes ComfyUI but it isn't answering yet at ${url} (${probeRes.status ?? probeRes.error}). It may still be booting — wait ~30s, or run runpod_pod_troubleshoot.` }] };
        }
        // Readiness needs MORE than /system_stats (#269): a ComfyUI whose core is
        // up but whose queue/prompt endpoint is broken would answer /system_stats
        // yet fail every render. Verify /queue answers too before declaring ready.
        const queueProbe = await probe(`${url}/queue`);
        if (!queueProbe.ok) {
          return { content: [{ type: "text", text: `Pod \`${pod.id}\` answers /system_stats but its queue endpoint isn't ready at ${url} (${queueProbe.status ?? queueProbe.error}) — ComfyUI may still be initializing. Wait ~30s, or run runpod_pod_troubleshoot.` }] };
        }
        const applied = setComfyuiTarget(url);
        if (!applied) return { content: [{ type: "text", text: `Resolved ${url} but could not retarget (unexpected URL parse failure).` }] };
        resetClient();
        // Cover the spawned-child case ONLY: it asks the orchestrator to
        // retarget + watch through the control channel (#269). In-process the
        // direct path already did everything synchronously — replaying the
        // same URL through the channel up to 700ms later could overwrite a
        // NEWER choice made meanwhile (codex finding). The generation guard
        // (expectedCurrentUrl) lets the orchestrator drop it if one happened.
        if (progressEnabled()) {
          // Confirm the AUTHORITATIVE retarget before reporting success: the
          // generation guard may have rejected this (a newer target won), and
          // only the child's private config changed otherwise (codex finding).
          const reqFile = requestTargetChange({ url, watchPodId: pod.id, expectedCurrentUrl: preRetargetUrl, wantAck: true });
          const ack = reqFile ? await awaitTargetApplied(reqFile, 4_000) : null;
          if (!ack?.applied) {
            // Rejected by the generation guard (a newer target won) — realign
            // THIS child to the authoritative target too, or it keeps using
            // the rejected pod for the rest of the turn (codex finding).
            if (ack?.url) {
              setComfyuiTarget(ack.url);
              resetClient();
            }
            return { content: [{ type: "text", text: `⚠️ Pod \`${pod.id}\` is ready at ${url}, but the session did NOT retarget — the orchestrator moved to a newer target in the meantime (or the request didn't land). Retry runpod_pod_connect \`${pod.id}\` if that's wrong.` }] };
          }
          // Align this child to the confirmed target (its setComfyuiTarget
          // above already did, but keep it explicit after the ack).
          return { content: [{ type: "text", text: `✅ Connected to RunPod pod \`${pod.id}\` — comfyui-mcp now targets ${url}. All comfyui tools this session run against the pod. Live status is now broadcasting to the control panel (with idle auto-stop).` }] };
        }
        // Start live status broadcasts + idle auto-stop for this pod (control panels).
        getRunpodWatcher()?.watch(pod.id);
        return { content: [{ type: "text", text: `✅ Connected to RunPod pod \`${pod.id}\` — comfyui-mcp now targets ${url}. All comfyui tools this session run against the pod. Live status is now broadcasting to the control panel (with idle auto-stop).` }] };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );

  // ── DEPLOY LINK (referral) ────────────────────────────────────────────────
  server.tool(
    "runpod_deploy_link",
    "Get the RunPod DEPLOY link for spinning up a NEW comfyui-mcp pod. Share this with the user whenever they have no pod, or want to create one — it opens RunPod pre-configured with our template AND carries our referral code, so their signup/spend credits us. Prefer handing over THIS link for pod creation (rather than describing the console steps), so the referral attaches. Read-only.",
    {},
    async () => {
      return {
        content: [
          {
            type: "text",
            text: `Deploy a new comfyui-mcp pod here (pre-loaded with our template; the link carries our referral so your usage supports the project):\n\n${runpodDeployLink()}\n\nAfter it deploys, grab the pod ID from the RunPod console and use runpod_pod_connect to point this session at it.\n\n${GPU_CLI_CREDIT}`,
          },
        ],
      };
    },
  );
}
