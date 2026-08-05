// Audio attachments on an agent turn (issue #790).
//
// Before this module the agent could DRIVE ComfyUI's audio tools but never HEAR
// anything: every backend attached only image content parts, so an audio file
// either never left the orchestrator or (worse) was handed to a vision part and
// silently ignored. This module owns the two things that must never be guessed:
//
//   1. WHICH bytes are audio we can actually deliver (mime + non-empty + size).
//   2. WHAT the user is told when we cannot deliver them.
//
// The governing rule for (2): a SILENTLY dropped attachment is the worst
// outcome. The user asks about a sound, the model answers from the text alone,
// and nothing in the transcript reveals it never heard it. So every path here
// ends in either "delivered" or a refusal the user reads verbatim, and every
// refusal names something that WOULD work from where the caller is standing.
//
// Wire formats (both live-verified against Ollama on 2026-08-04, gemma4:e2b —
// see docs/local-llms.mdx):
//   • Ollama native  POST /api/chat            → message.images[] (raw base64).
//     Ollama's own /v1/audio/transcriptions middleware does exactly this
//     (openai/openai.go FromTranscriptionRequest puts AudioData in Images), so
//     `images` is really "binary multimodal attachments", not strictly images.
//   • OpenAI dialect POST /v1/chat/completions → {type:"input_audio",
//     input_audio:{data,format}}. NOTE an audio data-URL in an `image_url` part
//     is a hard 400 ("invalid image input") — audio must never ride that part.
//   • ACP (Gemini/Grok CLI) session/prompt     → {type:"audio",data,mimeType},
//     and the spec REQUIRES the agent to have advertised the `audio` prompt
//     capability first, so unknown means deny (never a silent attempt).

/** A ComfyUI audio reference the panel sends so the orchestrator can fetch the
 *  bytes from /view and deliver them to the agent as an inline audio part.
 *  Structurally identical to ImageRef — deliberately a SEPARATE type so a call
 *  site can never pass audio where an image content part is built (which the
 *  OpenAI dialect rejects outright, and which Ollama would silently mis-encode). */
export interface AudioRef {
  filename: string;
  subfolder?: string;
  type?: string; // "input" | "output" | "temp" (ComfyUI /view folder)
}

/**
 * Extension → mime for audio we are willing to put on the wire. Keep this the
 * SINGLE source of truth: the accepted-format list quoted back to the user in a
 * refusal is derived from these keys, so the two can never drift.
 */
export const AUDIO_MIME_BY_EXT: Readonly<Record<string, string>> = Object.freeze({
  wav: "audio/wav",
  wave: "audio/wav",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  oga: "audio/ogg",
  opus: "audio/opus",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  webm: "audio/webm",
});

/** The formats a refusal message offers, derived from AUDIO_MIME_BY_EXT so the
 *  prose can never claim support the encoder table doesn't actually have. */
export function supportedAudioFormats(): string {
  return [...new Set(Object.keys(AUDIO_MIME_BY_EXT))].join(", ");
}

/** True for any mime we can encode as an audio part. */
export function isDeliverableAudioMime(mime: string): boolean {
  const m = mime.split(";")[0].trim().toLowerCase();
  return Object.values(AUDIO_MIME_BY_EXT).includes(m);
}

/** Mime for a filename, or null when the extension is not audio we deliver.
 *  Used both to CLASSIFY (is this attachment audio at all?) and to fill in a
 *  mime when the server's Content-Type is missing or generic. */
export function audioMimeForFilename(filename: string): string | null {
  const dot = filename.lastIndexOf(".");
  if (dot < 0 || dot === filename.length - 1) return null;
  const ext = filename.slice(dot + 1).toLowerCase();
  return AUDIO_MIME_BY_EXT[ext] ?? null;
}

/** OpenAI `input_audio.format` token for a mime. The OpenAI content part takes a
 *  bare format word, not a mime — a wrong token is rejected by strict endpoints,
 *  so this is an explicit table rather than a mime.split("/") guess. */
export function openAiAudioFormat(mime: string): string {
  switch (mime.split(";")[0].trim().toLowerCase()) {
    case "audio/wav":
      return "wav";
    case "audio/mpeg":
      return "mp3";
    case "audio/ogg":
      return "ogg";
    case "audio/opus":
      return "opus";
    case "audio/flac":
      return "flac";
    case "audio/mp4":
      return "m4a";
    case "audio/aac":
      return "aac";
    case "audio/webm":
      return "webm";
    default:
      return "wav";
  }
}

/**
 * Largest audio payload we will inline. A base64 body is ~1.33x the file, and a
 * local endpoint has to hold the whole request in memory before it decodes, so
 * this is a real limit rather than a formality. 24 MB comfortably covers a
 * full-length mp3/ogg song (the reporter's case in #790) while refusing an
 * uncompressed multi-minute WAV, which the refusal tells the user how to fix.
 */
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

/** Why an audio attachment did not reach the model. Every value has a distinct
 *  remedy — that is the point of enumerating them rather than one "failed". */
export type AudioRefusalReason =
  | "backend-has-no-audio-part"
  | "session-did-not-advertise-audio"
  | "model-lacks-audio-capability"
  | "unsupported-format"
  | "empty-file"
  | "too-large"
  | "fetch-failed";

/** One attachment's fate. `delivered` is only ever constructed AFTER the bytes
 *  are on the request — never in anticipation of it. */
export type AudioOutcome =
  | { status: "delivered"; filename: string; mime: string; bytes: number }
  | { status: "refused"; filename: string; reason: AudioRefusalReason; text: string };

/**
 * How confident we are that a delivered attachment actually reaches the model.
 *
 * "established" — the endpoint itself told us this model accepts audio (Ollama
 *   /api/show capabilities, or an ACP agent advertising the audio prompt
 *   capability). Nothing is claimed beyond what the server said.
 * "unverified"  — we have a correct content part for this dialect but NO probe
 *   to ask. We still attempt (refusing on a missing probe would deny audio to
 *   every endpoint that simply has no capability API), but the user is told the
 *   delivery is unconfirmed. A guard that cannot run is not a refusal.
 */
export type AudioConfidence = "established" | "unverified";

/** Model-facing note appended to the user text, so the model cannot answer as if
 *  it had heard something it never received. Mirrors the image note's contract. */
export function audioModelNote(refusals: AudioOutcome[]): string {
  const refused = refusals.filter((r) => r.status === "refused");
  if (!refused.length) return "";
  return (
    `\n\n[panel note: the user attached ${refused.length} audio file(s) that did NOT reach you — ` +
    refused.map((r) => `${r.filename} (${r.reason})`).join("; ") +
    `. You did NOT hear them. Do not describe, transcribe, analyse or imply anything about their contents; ` +
    `say plainly that the audio did not reach you.]`
  );
}

/** Model-facing note for an attempt we could not confirm landed. Deliberately
 *  weaker than the refusal note: the audio probably DID arrive. */
export function audioUnverifiedModelNote(count: number): string {
  return (
    `\n\n[panel note: ${count} audio file(s) were attached to this turn, but this endpoint exposes no ` +
    `capability probe so the delivery is UNCONFIRMED. If you cannot actually perceive the audio, say so ` +
    `plainly instead of guessing at its contents.]`
  );
}

/** User-facing summary line for a turn that carried audio. Returns null when
 *  there is nothing worth saying (everything delivered on an established path). */
export function audioUserNotice(
  outcomes: AudioOutcome[],
  confidence: AudioConfidence,
  model: string,
): string | null {
  const refused = outcomes.filter((o) => o.status === "refused");
  const delivered = outcomes.filter((o) => o.status === "delivered");
  const parts: string[] = [];
  if (refused.length) {
    // One line per refusal: they can have DIFFERENT causes and therefore
    // different remedies, and collapsing them would hide the actionable one.
    for (const r of refused) if (r.status === "refused") parts.push(`🔇 ${r.text}`);
  }
  if (delivered.length && confidence === "unverified") {
    // Deliberately phrased as what is ON the outgoing request, not as a
    // completed delivery: at the moment this is said the bytes are attached but
    // the response has not come back, and claiming otherwise would be exactly
    // the "reported as sent when it was not" failure this feature exists to
    // prevent. If the endpoint then rejects it, the caller's strip-and-retry
    // issues the correction.
    parts.push(
      `🎧 Attaching ${delivered.length} audio file(s) to ${model}. This endpoint exposes no capability ` +
        `probe, so I cannot confirm the model actually receives them — if the reply does not reflect what ` +
        `is in the file, it did not hear it. A local Ollama model reports its own audio capability, so ` +
        `that path can be checked (\`ollama pull ${AUDIO_CAPABLE_OLLAMA_MODELS[0]}\`).`,
    );
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** Audio-capable local models we have a concrete, checkable pull command for.
 *  Ollama's own release integration tests pin these as the audio-tested set
 *  (integration/reg_release_test.go: releaseAudioModels), which is why they are
 *  named here rather than a general "try a multimodal model" hand-wave. */
export const AUDIO_CAPABLE_OLLAMA_MODELS = ["gemma4:e2b", "gemma4:e4b", "nemotron3:33b"] as const;

/** Refusal text: this backend has no audio content part at all. Names the
 *  providers that DO, so the remedy is reachable from where the user is. */
export function noAudioPartText(backendId: string, filename: string): string {
  return (
    `I can't send ${filename} to the model: the ${backendId} provider has no audio input at all in this ` +
    `build, so the file would be dropped without either of us noticing. Audio attachments are delivered on ` +
    `the local Ollama-family providers (ollama / LM Studio / llama.cpp / OpenAI-compatible) — switch ` +
    `provider and re-send, or ask me to run a ComfyUI audio-analysis node over the file instead and read ` +
    `you the numbers.`
  );
}

/** Refusal text: the backend can carry audio, but this SESSION never advertised
 *  the capability, and the protocol forbids sending it unasked. */
export function sessionNotAdvertisedText(backendId: string, filename: string): string {
  return (
    `I can't send ${filename} to the model: this ${backendId} session did not advertise the ACP \`audio\` ` +
    `prompt capability, and the protocol requires that before audio may be attached — sending anyway would ` +
    `mean guessing whether the model heard it. Switch to a local Ollama-family provider with an ` +
    `audio-capable model (e.g. \`ollama pull ${AUDIO_CAPABLE_OLLAMA_MODELS[0]}\`) and re-send.`
  );
}

/** Refusal text: the endpoint answered our capability probe, and this model
 *  cannot take audio. Quotes what the server actually reported. */
export function modelLacksAudioText(model: string, capabilities: string[], filename: string): string {
  const caps = capabilities.length ? capabilities.join(", ") : "none reported";
  return (
    `I can't send ${filename} to ${model}: the server reports its capabilities as [${caps}] — no audio. ` +
    `Pull a model that can hear and select it, e.g. \`ollama pull ${AUDIO_CAPABLE_OLLAMA_MODELS[0]}\` ` +
    `(others: ${AUDIO_CAPABLE_OLLAMA_MODELS.slice(1).join(", ")}). Until then I have not heard this file ` +
    `and won't pretend otherwise.`
  );
}

/** Refusal text: not a format we can encode. */
export function unsupportedFormatText(filename: string, mime: string | null): string {
  return (
    `I can't send ${filename} to the model: ${mime ? `its type is ${mime}, which` : "it has no audio file extension I recognise, so it"} ` +
    `is not an audio format I can encode. Convert it to one of: ${supportedAudioFormats()} — and re-attach.`
  );
}

/** Refusal text: the attachment exists but has no bytes. */
export function emptyAudioText(filename: string): string {
  return (
    `I can't send ${filename} to the model: the file is 0 bytes, so there is nothing to hear. ` +
    `Re-export or re-upload it and attach it again.`
  );
}

/** Refusal text: too big to inline. */
export function tooLargeAudioText(filename: string, bytes: number): string {
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  const capMb = (MAX_AUDIO_BYTES / (1024 * 1024)).toFixed(0);
  return (
    `I can't send ${filename} to the model: it is ${mb} MB and the inline limit is ${capMb} MB. ` +
    `Re-encode it as mp3 or ogg, or trim it to the section you want me to listen to, and re-attach.`
  );
}

/**
 * Most audio attachments carried on ONE turn.
 *
 * Low on purpose: audio is far more token-dense than an image — measured live
 * against gemma4:e2b, 1.5 s of 16 kHz WAV cost ~40 prompt tokens (~27 tok/s), so
 * a single 3-minute song is already ~5k tokens of a small model's window. The
 * excess is REFUSED OUT LOUD rather than truncated away, because a quietly
 * dropped third attachment is the same silent failure as a dropped first one.
 */
export const MAX_AUDIO_ATTACHMENTS = 2;

/** Refusal text: more attachments than one turn will carry. */
export function tooManyAudioText(filename: string, limit: number): string {
  return (
    `I can't send ${filename} to the model: only ${limit} audio file(s) fit on one turn ` +
    `(audio is token-expensive — roughly 27 prompt tokens per second of sound). ` +
    `Send it on its own follow-up message and I'll listen to it then.`
  );
}

/** Refusal text: we could not read the bytes out of ComfyUI. */
export function fetchFailedAudioText(filename: string, detail: string): string {
  return (
    `I can't send ${filename} to the model: fetching it from ComfyUI failed (${detail}). ` +
    `Check the file still exists in the ComfyUI input/output folder and re-attach it.`
  );
}

export type AudioFetchResult =
  | { ok: true; b64: string; mime: string; bytes: number }
  | { ok: false; outcome: AudioOutcome };

/**
 * Fetch one audio attachment out of ComfyUI's /view and classify it.
 *
 * Shared by every backend that can carry audio, so the four failure shapes the
 * user can hit — unreadable extension, non-audio Content-Type, zero bytes, over
 * the inline cap — produce the SAME actionable refusal wherever they occur.
 * There is deliberately no `null` return: "couldn't read it" must never be
 * indistinguishable from "there was nothing to attach".
 */
export async function fetchAudioAttachment(
  comfyuiUrl: string | undefined,
  ref: AudioRef,
  fetchImpl: typeof fetch = fetch,
): Promise<AudioFetchResult> {
  const refuse = (reason: AudioRefusalReason, text: string): AudioFetchResult => ({
    ok: false,
    outcome: { status: "refused", filename: ref.filename, reason, text },
  });
  if (!ref?.filename) return refuse("fetch-failed", fetchFailedAudioText("(unnamed)", "the attachment carried no filename"));
  const nameMime = audioMimeForFilename(ref.filename);
  if (!nameMime) return refuse("unsupported-format", unsupportedFormatText(ref.filename, null));
  if (!comfyuiUrl) {
    return refuse("fetch-failed", fetchFailedAudioText(ref.filename, "no ComfyUI URL is configured for this agent"));
  }
  try {
    const u = new URL("/view", comfyuiUrl);
    u.searchParams.set("filename", ref.filename);
    u.searchParams.set("type", ref.type || "input");
    if (ref.subfolder) u.searchParams.set("subfolder", ref.subfolder);
    const res = await fetchImpl(u, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) return refuse("fetch-failed", fetchFailedAudioText(ref.filename, `http ${res.status}`));
    const ct = (res.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    // An explicitly-audio Content-Type we cannot encode is a real answer and is
    // refused by name. Anything else (missing, or the application/octet-stream
    // ComfyUI's /view usually sends) falls back to the extension, which already
    // passed the check above.
    let mime = nameMime;
    if (ct.startsWith("audio/")) {
      if (!isDeliverableAudioMime(ct)) return refuse("unsupported-format", unsupportedFormatText(ref.filename, ct));
      mime = ct;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) return refuse("empty-file", emptyAudioText(ref.filename));
    if (buf.length > MAX_AUDIO_BYTES) return refuse("too-large", tooLargeAudioText(ref.filename, buf.length));
    return { ok: true, b64: buf.toString("base64"), mime, bytes: buf.length };
  } catch (err) {
    return refuse("fetch-failed", fetchFailedAudioText(ref.filename, err instanceof Error ? err.message : String(err)));
  }
}

/**
 * Split a mixed attachment list into images and audio by FILENAME EXTENSION.
 *
 * A panel that only knows about `images` can still attach a .wav, and routing it
 * to an image content part is not a harmless no-op: on the OpenAI dialect it is
 * a hard 400, and on the native dialect it lands in an image slot. Splitting
 * here means the audio path claims it (and can refuse it honestly) instead.
 */
export function splitAudioAttachments<T extends { filename: string }>(
  refs: readonly T[] | undefined,
): { images: T[]; audio: T[] } {
  const images: T[] = [];
  const audio: T[] = [];
  for (const ref of refs ?? []) {
    if (audioMimeForFilename(ref.filename)) audio.push(ref);
    else images.push(ref);
  }
  return { images, audio };
}
