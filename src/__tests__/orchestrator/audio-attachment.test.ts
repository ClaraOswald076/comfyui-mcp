import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_MIME_BY_EXT,
  MAX_AUDIO_BYTES,
  audioMimeForFilename,
  audioModelNote,
  audioUserNotice,
  fetchAudioAttachment,
  isDeliverableAudioMime,
  looksLikeAudioFilename,
  modelLacksAudioText,
  noAudioPartText,
  openAiAudioFormat,
  sessionNotAdvertisedText,
  splitAudioAttachments,
  supportedAudioFormats,
  unsupportedFormatText,
} from "../../orchestrator/audio-attachment.js";

// Every refusal in #790 must be ACTIONABLE from where the caller is standing —
// "I can't" with no next step is the same dead end as a silent drop, just
// noisier. These tests assert the remedy is present, not merely that we refused.

describe("audio mime classification", () => {
  it("recognises the audio extensions we can encode, and nothing else", () => {
    expect(audioMimeForFilename("song.mp3")).toBe("audio/mpeg");
    expect(audioMimeForFilename("take1.WAV")).toBe("audio/wav");
    expect(audioMimeForFilename("voice.ogg")).toBe("audio/ogg");
    expect(audioMimeForFilename("stem.flac")).toBe("audio/flac");
    // Not audio, and — the case that matters — not silently coerced into one.
    expect(audioMimeForFilename("shot.png")).toBeNull();
    expect(audioMimeForFilename("clip.mp4")).toBeNull();
    expect(audioMimeForFilename("noextension")).toBeNull();
    expect(audioMimeForFilename("trailing.")).toBeNull();
  });

  it("isDeliverableAudioMime accepts our table and rejects other media", () => {
    expect(isDeliverableAudioMime("audio/wav")).toBe(true);
    expect(isDeliverableAudioMime("audio/mpeg; charset=binary")).toBe(true);
    expect(isDeliverableAudioMime("audio/midi")).toBe(false);
    expect(isDeliverableAudioMime("image/png")).toBe(false);
  });

  it("the format list quoted to the user is DERIVED from the encoder table", () => {
    // If the two ever drift, a refusal starts advertising a format we cannot
    // actually send. Derivation is the fix; this is the guard on it.
    const advertised = supportedAudioFormats().split(", ");
    expect(advertised.sort()).toEqual([...new Set(Object.keys(AUDIO_MIME_BY_EXT))].sort());
    expect(advertised).toContain("mp3");
  });

  it("maps each mime to the OpenAI input_audio format token", () => {
    expect(openAiAudioFormat("audio/wav")).toBe("wav");
    expect(openAiAudioFormat("audio/mpeg")).toBe("mp3");
    expect(openAiAudioFormat("audio/flac")).toBe("flac");
    expect(openAiAudioFormat("audio/mp4")).toBe("m4a");
  });
});

describe("splitAudioAttachments", () => {
  it("routes audio-named files OUT of the image list", () => {
    // An audio file left in `images` is a hard 400 on the OpenAI dialect
    // ("invalid image input", reproduced live) — this split is what stops it.
    const { images, audio } = splitAudioAttachments([
      { filename: "shot.png" },
      { filename: "song.mp3" },
      { filename: "render.webp" },
      { filename: "voice.wav" },
    ]);
    expect(images.map((i) => i.filename)).toEqual(["shot.png", "render.webp"]);
    expect(audio.map((a) => a.filename)).toEqual(["song.mp3", "voice.wav"]);
  });

  it("handles an undefined list without inventing entries", () => {
    expect(splitAudioAttachments(undefined)).toEqual({ images: [], audio: [] });
  });

  it("claims audio we CANNOT encode too — so the user gets a convert-to hint, not an image error", () => {
    // Classification and encodability are different questions. A .wma left on
    // the image path becomes a 400 (OpenAI dialect) or an image-slot mis-encode
    // (native) — neither of which tells the user to convert the file.
    const { images, audio } = splitAudioAttachments([
      { filename: "song.wma" },
      { filename: "tune.mid" },
      { filename: "master.aiff" },
      { filename: "shot.png" },
    ]);
    expect(audio.map((a) => a.filename)).toEqual(["song.wma", "tune.mid", "master.aiff"]);
    expect(images.map((i) => i.filename)).toEqual(["shot.png"]);
    // …and they are still NOT encodable, so the fetch path refuses them.
    expect(audioMimeForFilename("song.wma")).toBeNull();
    expect(looksLikeAudioFilename("song.wma")).toBe(true);
  });
});

describe("refusal texts name a remedy", () => {
  it("a backend with no audio part points at one that has", () => {
    const t = noAudioPartText("claude", "song.mp3");
    expect(t).toContain("song.mp3");
    expect(t).toContain("claude");
    expect(t.toLowerCase()).toContain("ollama");
  });

  it("a model without the capability quotes what the server reported AND a pull command", () => {
    const t = modelLacksAudioText("qwen3:4b", ["completion", "tools"], "song.mp3");
    expect(t).toContain("qwen3:4b");
    expect(t).toContain("completion, tools");
    expect(t).toContain("ollama pull");
  });

  it("an unadvertised ACP session explains the protocol rule, not just the failure", () => {
    const t = sessionNotAdvertisedText("gemini", "song.mp3");
    expect(t).toContain("audio");
    expect(t).toContain("ollama pull");
  });

  it("an unsupported format lists the formats that would work", () => {
    const t = unsupportedFormatText("clip.mp4", null);
    expect(t).toContain("mp3");
    expect(t).toContain("wav");
  });
});

describe("model-facing notes", () => {
  it("a refusal tells the MODEL it did not hear the file", () => {
    const note = audioModelNote([
      { status: "refused", filename: "song.mp3", reason: "model-lacks-audio-capability", text: "..." },
    ]);
    expect(note).toContain("song.mp3");
    expect(note).toContain("did NOT hear");
    // The whole point: forbid confabulation, explicitly.
    expect(note).toContain("Do not describe");
  });

  it("says nothing when every attachment landed", () => {
    expect(audioModelNote([{ status: "delivered", filename: "a.wav", mime: "audio/wav", bytes: 10 }])).toBe("");
  });
});

describe("audioUserNotice", () => {
  it("stays silent when delivery was established and nothing was refused", () => {
    const n = audioUserNotice(
      [{ status: "delivered", filename: "a.wav", mime: "audio/wav", bytes: 10 }],
      "established",
      "gemma4:e2b",
    );
    expect(n).toBeNull();
  });

  it("warns — WITHOUT claiming delivery — when the endpoint offers no probe", () => {
    const n = audioUserNotice(
      [{ status: "delivered", filename: "a.wav", mime: "audio/wav", bytes: 10 }],
      "unverified",
      "vendor/some-model",
    );
    expect(n).toContain("cannot confirm");
    // "Attaching", never "Sent": at this point the response has not come back,
    // and reporting a completed delivery would be the exact overclaim #790 is
    // about.
    expect(n).toContain("Attaching");
    expect(n).not.toContain("Sent ");
  });

  it("emits one line PER refusal, because two refusals can have two remedies", () => {
    const n = audioUserNotice(
      [
        { status: "refused", filename: "a.wav", reason: "empty-file", text: "A-REMEDY" },
        { status: "refused", filename: "b.mp3", reason: "too-large", text: "B-REMEDY" },
      ],
      "established",
      "gemma4:e2b",
    );
    expect(n).toContain("A-REMEDY");
    expect(n).toContain("B-REMEDY");
  });
});

describe("fetchAudioAttachment", () => {
  const url = "http://127.0.0.1:8188";
  const okResponse = (bytes: Uint8Array, contentType = "application/octet-stream") =>
    new Response(bytes, { status: 200, headers: { "content-type": contentType } });

  it("delivers the bytes and the extension-derived mime", async () => {
    const f = vi.fn(async () => okResponse(new Uint8Array([1, 2, 3, 4])));
    const r = await fetchAudioAttachment(url, { filename: "song.mp3", type: "input" }, f as unknown as typeof fetch);
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("unreachable");
    expect(r.mime).toBe("audio/mpeg");
    expect(r.bytes).toBe(4);
    expect(r.b64).toBe(Buffer.from([1, 2, 3, 4]).toString("base64"));
  });

  it("prefers an explicit audio Content-Type over the extension", async () => {
    const f = vi.fn(async () => okResponse(new Uint8Array([1]), "audio/flac"));
    const r = await fetchAudioAttachment(url, { filename: "x.wav" }, f as unknown as typeof fetch);
    expect(r.ok && r.mime).toBe("audio/flac");
  });

  it("REFUSES a non-audio extension without ever fetching", async () => {
    const f = vi.fn(async () => okResponse(new Uint8Array([1])));
    const r = await fetchAudioAttachment(url, { filename: "clip.mp4" }, f as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.outcome.status === "refused" && r.outcome.reason).toBe("unsupported-format");
    expect(f).not.toHaveBeenCalled();
  });

  it("REFUSES an audio Content-Type we cannot encode, naming it", async () => {
    const f = vi.fn(async () => okResponse(new Uint8Array([1]), "audio/midi"));
    const r = await fetchAudioAttachment(url, { filename: "x.wav" }, f as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.outcome.status === "refused" && r.outcome.reason).toBe("unsupported-format");
    expect(r.outcome.status === "refused" && r.outcome.text).toContain("audio/midi");
  });

  it("REFUSES an attachment that is present but EMPTY", async () => {
    const f = vi.fn(async () => okResponse(new Uint8Array([])));
    const r = await fetchAudioAttachment(url, { filename: "silence.wav" }, f as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.outcome.status === "refused" && r.outcome.reason).toBe("empty-file");
    expect(r.outcome.status === "refused" && r.outcome.text).toContain("0 bytes");
  });

  it("REFUSES an attachment over the inline cap, naming the size and a fix", async () => {
    const f = vi.fn(async () => okResponse(new Uint8Array(MAX_AUDIO_BYTES + 1)));
    const r = await fetchAudioAttachment(url, { filename: "long.wav" }, f as unknown as typeof fetch);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable");
    expect(r.outcome.status === "refused" && r.outcome.reason).toBe("too-large");
    expect(r.outcome.status === "refused" && r.outcome.text).toContain("Re-encode");
  });

  it("REFUSES (never returns empty) when ComfyUI errors or throws", async () => {
    const http = vi.fn(async () => new Response("nope", { status: 404 }));
    const r1 = await fetchAudioAttachment(url, { filename: "a.wav" }, http as unknown as typeof fetch);
    expect(r1.ok === false && r1.outcome.status === "refused" && r1.outcome.reason).toBe("fetch-failed");

    const boom = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const r2 = await fetchAudioAttachment(url, { filename: "a.wav" }, boom as unknown as typeof fetch);
    expect(r2.ok === false && r2.outcome.status === "refused" && r2.outcome.reason).toBe("fetch-failed");
    expect(r2.ok === false && r2.outcome.status === "refused" && r2.outcome.text).toContain("ECONNREFUSED");
  });

  it("REFUSES when no ComfyUI URL is configured, rather than returning nothing", async () => {
    const r = await fetchAudioAttachment(undefined, { filename: "a.wav" });
    expect(r.ok === false && r.outcome.status === "refused" && r.outcome.reason).toBe("fetch-failed");
  });
});
