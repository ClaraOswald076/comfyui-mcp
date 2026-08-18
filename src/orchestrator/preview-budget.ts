// #1516 — the CUMULATIVE, per-conversation budget on AUTOMATIC run-completion
// previews.
//
// Why a second budget on top of the per-turn one
// (MAX_RUN_COMPLETION_IMAGE_ATTACHMENTS in panel-agent.ts): the per-turn ceiling
// bounds ONE turn, but a long session drains 8 previews per turn into the SAME
// provider conversation, and Codex persists every delivered localImage as an
// inline `input_image` data URL in the thread rollout — which its compaction
// path then retains and recopies without a media-aware bound (openai/codex#33493).
// Measured on the reporter's session: 265 persisted input_images, an 18.2 GiB
// rollout, ~487 MB recopied per compaction, and a resumed app-server stalled at
// ~9 GB private bytes. The per-turn cap alone still lets N turns accumulate 8N
// images, so the conversation itself needs a ceiling.
//
// Two dimensions, because a count-only cap lies about cost: previews range from
// a 50 KB icon to the 12 MB per-file fetch cap, and it is the BYTES that Codex
// inlines and recopies. The count is known exactly at the drain (panel-agent
// charges it when previews are committed to a turn); the bytes are known only
// where the fetch happens (the backend), so byte accounting lives in the
// backend and panel-agent reads it back through AgentBackend.automaticPreviewBytes.
//
// Both bounds are deliberately CONSERVATIVE defaults, overridable for tuning and
// tests. Explicit USER attachments never spend this budget (the `automatic` flag
// on ImageRef is what separates them) — #1516 asks for those to keep their own
// reviewed policy.

/** Cumulative AUTOMATIC preview images one provider conversation may receive
 *  before automatic delivery stops (the notice stays, the pixels stop, and the
 *  text says so with get_image coordinates). Overridable via
 *  COMFYUI_MCP_SESSION_PREVIEW_ATTACHMENTS. */
export const MAX_SESSION_PREVIEW_ATTACHMENTS =
  Number(process.env.COMFYUI_MCP_SESSION_PREVIEW_ATTACHMENTS) || 48;

/** Cumulative fetched BYTES of automatic previews one provider conversation may
 *  receive. This is the bound that actually speaks to Codex's inline-media
 *  amplification: ~128 MiB of fetched bytes is ~170 MiB of base64 the rollout
 *  retains and every later compaction recopies. Overridable via
 *  COMFYUI_MCP_SESSION_PREVIEW_BYTES. */
export const MAX_SESSION_PREVIEW_BYTES =
  Number(process.env.COMFYUI_MCP_SESSION_PREVIEW_BYTES) || 128 * 1024 * 1024;

/** The delivered-so-far ledger for ONE provider conversation (#1516). `images`
 *  is exact (charged at the drain); `bytes` is the sum the backend reports for
 *  fetches it actually completed, so it lags by the in-flight turn at most. */
export interface PreviewLedger {
  images: number;
  bytes: number;
}

/** Human-facing rendering of the byte budget for notices ("128 MB"). */
export function previewByteBudgetLabel(): string {
  return `${Math.round(MAX_SESSION_PREVIEW_BYTES / (1024 * 1024))} MB`;
}
