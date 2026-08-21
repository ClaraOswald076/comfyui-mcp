import { describe, expect, it, vi } from "vitest";
import {
  AUDIO_CAPABLE_OLLAMA_MODELS,
  AUDIO_MIME_BY_EXT,
  MAX_AUDIO_BYTES,
  audioMimeForFilename,
  audioModelNote,
  audioUserNotice,
  fetchAudioAttachment,
  isDeliverableAudioMime,
  isKnownAudioCapableOllamaModel,
  looksLikeAudioFilename,
  modelLacksAudioText,
  modelNotVerifiedAudioText,
  noAudioPartText,
  openAiAudioFormat,
  dedupeAudioRefs,
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

describe("isKnownAudioCapableOllamaModel — native images[] allowlist", () => {
  it("accepts every tag in the verified set, and the official library/ prefix", () => {
    for (const model of AUDIO_CAPABLE_OLLAMA_MODELS) {
      expect(isKnownAudioCapableOllamaModel(model)).toBe(true);
      expect(isKnownAudioCapableOllamaModel(`library/${model}`)).toBe(true);
      expect(isKnownAudioCapableOllamaModel(model.toUpperCase())).toBe(true);
    }
  });

  it("rejects the #1972 fabrication model even though it is a Gemma 4 fork", () => {
    expect(isKnownAudioCapableOllamaModel("huihui_ai/gemma-4-abliterated:E4b-qat")).toBe(false);
  });

  it("rejects the default fine-tune — that tag HTTP 400s on audio in images[]", () => {
    expect(isKnownAudioCapableOllamaModel("artokun/gemma4-comfyui-mcp:e4b")).toBe(false);
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

  it("claims the audio containers people actually have, not just the obvious four", () => {
    // A missed extension is not a cosmetic gap: the file goes down the IMAGE
    // path, whose fetcher relabels the bytes image/png, and the user is told we
    // could not SEE their audiobook rather than how to convert it.
    const { audio, images } = splitAudioAttachments([
      { filename: "book.m4b" },
      { filename: "set.mka" },
      { filename: "track.mpga" },
      { filename: "voice.spx" },
      { filename: "clip.weba" },
      { filename: "shot.png" },
    ]);
    expect(audio.map((a) => a.filename)).toEqual([
      "book.m4b",
      "set.mka",
      "track.mpga",
      "voice.spx",
      "clip.weba",
    ]);
    expect(images.map((i) => i.filename)).toEqual(["shot.png"]);
    // m4b/mpga/weba are real containers we CAN encode; mka/spx are not.
    expect(audioMimeForFilename("book.m4b")).toBe("audio/mp4");
    expect(audioMimeForFilename("track.mpga")).toBe("audio/mpeg");
    expect(audioMimeForFilename("clip.weba")).toBe("audio/webm");
    expect(audioMimeForFilename("set.mka")).toBeNull();
    expect(audioMimeForFilename("voice.spx")).toBeNull();
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

  it("an unverified native model names the image-slot risk AND a pull command, without claiming the server said no audio", () => {
    // #1972: /api/show may list `audio` (architecture) while the weights invent
    // a transcript. The refusal must not quote a "no audio" verdict we did not
    // get; it must name the verified set the user can switch to.
    const t = modelNotVerifiedAudioText("huihui_ai/gemma-4-abliterated:E4b-qat", "song.wav");
    expect(t).toContain("huihui_ai/gemma-4-abliterated:E4b-qat");
    expect(t).toContain("song.wav");
    expect(t).toContain("invent a transcript");
    expect(t).toContain("ollama pull");
    expect(t).not.toContain("no audio");
    for (const known of AUDIO_CAPABLE_OLLAMA_MODELS) expect(t).toContain(known);
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

  it("REFUSES a NON-audio Content-Type rather than trusting the extension", async () => {
    // A 200 from a proxy or a mis-served file can be text/html or image/png
    // under a .wav name. Attaching those bytes would produce a success message
    // for a "delivery" that contains no sound — the silent failure this path
    // exists to prevent, wearing a success message.
    for (const ct of ["text/html", "image/png", "application/json", "video/mp4"]) {
      const f = vi.fn(async () => okResponse(new Uint8Array([1, 2, 3]), ct));
      const r = await fetchAudioAttachment(url, { filename: "song.wav" }, f as unknown as typeof fetch);
      expect(r.ok).toBe(false);
      if (r.ok) throw new Error("unreachable");
      expect(r.outcome.status === "refused" && r.outcome.reason).toBe("unsupported-format");
      expect(r.outcome.status === "refused" && r.outcome.text).toContain(ct);
    }
  });

  it("still accepts the generic binary types ComfyUI's /view actually sends", async () => {
    for (const ct of ["application/octet-stream", "binary/octet-stream", ""]) {
      const f = vi.fn(async () => okResponse(new Uint8Array([1, 2, 3]), ct));
      const r = await fetchAudioAttachment(url, { filename: "song.wav" }, f as unknown as typeof fetch);
      expect(r.ok).toBe(true);
      expect(r.ok && r.mime).toBe("audio/wav");
    }
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

describe("dedupeAudioRefs — one file attached on two carriers is ONE attachment", () => {
  it("collapses the same ComfyUI file arriving in both `images` and `audio`", () => {
    // The panel has two carriers. A composer that populates both would otherwise
    // spend two of the turn's slots on one sound, and the SECOND copy comes back
    // to the user as "only 2 audio file(s) fit on one turn" — a refusal of a file
    // that is already on the request.
    const refs = [
      { filename: "song.wav", type: "input" },
      { filename: "song.wav", type: "input" },
      { filename: "voice.mp3", type: "input" },
    ];
    expect(dedupeAudioRefs(refs)).toEqual([
      { filename: "song.wav", type: "input" },
      { filename: "voice.mp3", type: "input" },
    ]);
  });

  it("treats an absent `type` as the fetcher's own default, not as a different file", () => {
    // fetchAudioAttachment sends type=input when the ref omits it, so these two
    // refs address byte-for-byte the same /view response.
    expect(dedupeAudioRefs([{ filename: "song.wav" }, { filename: "song.wav", type: "input" }])).toHaveLength(1);
  });

  it("keeps files that really are different — same name, different folder or type", () => {
    expect(
      dedupeAudioRefs([
        { filename: "song.wav", type: "input" },
        { filename: "song.wav", type: "output" },
        { filename: "song.wav", subfolder: "takes", type: "input" },
      ]),
    ).toHaveLength(3);
  });
});
