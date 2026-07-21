import { z } from "zod";
import type { HistoryEntry } from "../comfyui/client.js";

export const TRACEBACK_MAX_CHARS = 2000;

export interface ExecutionErrorDetails {
  node_id: string;
  node_type: string;
  exception_message: string;
  exception_type?: string;
  traceback?: string;
  traceback_truncated?: boolean;
  current_inputs?: unknown;
  is_oom?: boolean;
}

export interface ExecutionStats {
  total_duration_ms?: number;
  nodes: Record<string, { duration_ms: number }>;
}

/** Text produced by a preview/show-text node, keyed by the node that emitted it. */
export interface TextOutput {
  node_id: string;
  text: string[];
}

export interface HistoryAnalysis {
  error?: ExecutionErrorDetails;
  execution_stats?: ExecutionStats;
  /** Present only when the run actually produced text (omitted otherwise so
   *  image-only runs don't carry an empty array around). */
  text_outputs?: TextOutput[];
}

export type HistoryStatusMessage = readonly [string, Record<string, unknown>];

const executionErrorSchema = z.object({
  node_id: z.union([z.string(), z.number()]).optional(),
  node_type: z.string().optional(),
  exception_message: z.string().optional(),
  exception_type: z.string().optional(),
  traceback: z.union([z.string(), z.array(z.string())]).optional(),
  current_inputs: z.unknown().optional(),
}).passthrough();

export function normalizeHistoryMessages(
  entry: HistoryEntry,
): HistoryStatusMessage[] {
  const rawMessages = entry.status.messages;
  if (!Array.isArray(rawMessages)) return [];

  const messages: HistoryStatusMessage[] = [];
  for (const rawMessage of rawMessages) {
    if (!Array.isArray(rawMessage) || rawMessage.length < 2) continue;
    const [type, data] = rawMessage;
    if (typeof type !== "string") continue;
    if (data === null || typeof data !== "object" || Array.isArray(data)) continue;
    messages.push([type, data as Record<string, unknown>]);
  }
  return messages;
}

function messageData(
  entry: HistoryEntry,
  type: string,
): Record<string, unknown> | undefined {
  const msg = normalizeHistoryMessages(entry).find((m) => m[0] === type);
  return msg?.[1];
}

function timestamp(data: Record<string, unknown> | undefined): number | undefined {
  const raw = data?.timestamp;
  return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

function durationMs(start: number, end: number): number | undefined {
  const delta = end - start;
  if (!Number.isFinite(delta) || delta < 0) return undefined;

  // ComfyUI history commonly uses epoch seconds; some websocket/event docs use
  // epoch milliseconds. Infer the unit from absolute magnitude, then fall back
  // to seconds for short relative durations.
  if (start > 1_000_000_000_000 || end > 1_000_000_000_000) {
    return Math.round(delta);
  }
  if (start > 1_000_000_000 || end > 1_000_000_000 || delta < 1000) {
    return Math.round(delta * 1000);
  }
  return Math.round(delta);
}

function tracebackText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((line) => String(line)).join("");
  return undefined;
}

function truncateTraceback(text: string): { text: string; truncated: boolean } {
  if (text.length <= TRACEBACK_MAX_CHARS) return { text, truncated: false };
  return { text: text.slice(0, TRACEBACK_MAX_CHARS), truncated: true };
}

function isOomError(error: ExecutionErrorDetails): boolean {
  const haystack = [
    error.exception_type,
    error.exception_message,
    error.traceback,
  ].filter(Boolean).join("\n").toLowerCase();
  return haystack.includes("out of memory") || haystack.includes("cuda oom");
}

export function extractExecutionError(
  entry: HistoryEntry,
): ExecutionErrorDetails | undefined {
  const parsed = executionErrorSchema.safeParse(messageData(entry, "execution_error"));
  if (!parsed.success) return undefined;

  const data = parsed.data;
  const rawTraceback = tracebackText(data.traceback);
  const traceback = rawTraceback ? truncateTraceback(rawTraceback) : undefined;
  const error: ExecutionErrorDetails = {
    node_id: data.node_id === undefined ? "" : String(data.node_id),
    node_type: data.node_type ?? "",
    exception_message: data.exception_message ?? "",
    exception_type: data.exception_type,
    traceback: traceback?.text,
    traceback_truncated: traceback?.truncated || undefined,
    current_inputs: data.current_inputs,
  };

  if (isOomError(error)) error.is_oom = true;
  return error;
}

export function extractExecutionStats(
  entry: HistoryEntry,
): ExecutionStats | undefined {
  const messages = normalizeHistoryMessages(entry);
  const startTs = timestamp(messageData(entry, "execution_start"));
  const endMsg = messages.find(
    (m) => m[0] === "execution_success" || m[0] === "execution_error",
  );
  const endTs = timestamp(endMsg?.[1]);
  const nodes: ExecutionStats["nodes"] = {};

  let previousTs = startTs;
  for (const [type, data] of messages) {
    if (type !== "executed") continue;
    const executedTs = timestamp(data);
    const nodeId = data.node ?? data.node_id ?? data.display_node;
    if (executedTs === undefined || nodeId === undefined) continue;

    if (previousTs !== undefined) {
      const nodeDuration = durationMs(previousTs, executedTs);
      if (nodeDuration !== undefined) {
        nodes[String(nodeId)] = { duration_ms: nodeDuration };
      }
    }
    previousTs = executedTs;
  }

  const totalDuration =
    startTs !== undefined && endTs !== undefined
      ? durationMs(startTs, endTs)
      : undefined;

  if (totalDuration === undefined && Object.keys(nodes).length === 0) {
    return undefined;
  }
  return {
    total_duration_ms: totalDuration,
    nodes,
  };
}

/**
 * Pull TEXT results out of a finished run.
 *
 * Text-preview nodes (ComfyUI's "Preview as Text", ShowText, and the many pack
 * equivalents) have no file on disk — they publish their result into the node's
 * `ui` dict, which is exactly what /history stores under
 * `outputs[nodeId]`. We only ever harvested `images` / `videos` there, so an
 * LLM-caption / prompt-builder / text workflow completed with the agent seeing
 * NOTHING — it would say it was going to report back and then have nothing to
 * report (help-thread report from seanmcmagic).
 *
 * Shapes in the wild: `{ text: ["hi"] }` (the common one), `{ text: "hi" }`, and
 * packs that use `string` instead of `text`. Non-string scalars are stringified;
 * empty strings are dropped so a node that emitted nothing stays absent.
 */
export function extractTextOutputs(entry: HistoryEntry): TextOutput[] {
  const results: TextOutput[] = [];
  const outputs = (entry as { outputs?: Record<string, unknown> }).outputs;
  if (!outputs || typeof outputs !== "object") return results;

  for (const [nodeId, nodeOutput] of Object.entries(outputs)) {
    if (!nodeOutput || typeof nodeOutput !== "object") continue;
    const record = nodeOutput as Record<string, unknown>;
    const text: string[] = [];

    for (const key of ["text", "string"] as const) {
      const value = record[key];
      if (typeof value === "string") {
        if (value.length > 0) text.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") {
            if (item.length > 0) text.push(item);
          } else if (typeof item === "number" || typeof item === "boolean") {
            text.push(String(item));
          }
        }
      }
    }

    if (text.length > 0) results.push({ node_id: nodeId, text });
  }
  return results;
}

export function analyzeHistoryEntry(entry: HistoryEntry): HistoryAnalysis {
  const text_outputs = extractTextOutputs(entry);
  return {
    error: extractExecutionError(entry),
    execution_stats: extractExecutionStats(entry),
    ...(text_outputs.length > 0 ? { text_outputs } : {}),
  };
}
