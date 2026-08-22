// Turn-start stall/backlog note for the panel orchestrator (#559).
//
// Kept as a named export so tests can drive the SAME wording the injector
// prepends — QueueMonitor.report() → formatQueueNote() — without booting the
// orchestrator. A mutation that reintroduces "this session didn't queue" for
// a self-owned render (or pairs a routine batch with clear_pending) must fail
// here, not only in production.

import type { StallReport } from "../services/queue-monitor.js";

/** Build a one-line agent note from a stall/backlog report, or null when the
 *  queue is healthy. Stall takes priority over a plain backlog. */
export function formatQueueNote(rep: StallReport): string | null {
  if (rep.stalled) {
    const secs = Math.round(rep.stalledForMs / 1000);
    return (
      `⚠️ The current ComfyUI render appears STALLED: ` +
      `${rep.currentNode ? `node ${rep.currentNode} ` : ""}${rep.progress ? `(progress ${rep.progress}) ` : ""}` +
      `on prompt ${rep.runningPromptId ?? "?"} has not advanced for ~${secs}s. ComfyUI only checks interrupts ` +
      `BETWEEN steps, so a stuck step can ignore a cancel. If it's wedged: call queue (action:"cancel") with ` +
      `clear_pending:true; if it reports the job still wedged, restart_comfyui / panel_restart_comfyui. ` +
      `Do NOT queue another run on top.`
    );
  }
  // A plain backlog (depth > 1) is NOT evidence of a wedge — deliberately queuing
  // a batch is a normal workflow. Suppress the note entirely when the in-flight
  // work is this session's own jobs, and when extra depth has no VISIBLE foreign
  // id (stale queueRemaining vs a poll that already listed every real job).
  // Claiming "this session didn't queue" is only honest when a visible in-flight
  // id is not one we recorded. A genuinely stalled job is handled above (#559).
  if (rep.backlog && rep.foreignVisible) {
    const pending = Math.max(0, rep.queueDepth - 1);
    return (
      `ℹ️ ComfyUI queue: ${rep.queueDepth} tasks in flight (1 running + ${pending} pending) that this session ` +
      `didn't queue. This is only a problem if the running one is stuck — inspect with queue (action:"list"). ` +
      `queue (action:"cancel_queued") drops a single pending item; queue (action:"cancel") with clear_pending:true resets everything.`
    );
  }
  return null;
}
