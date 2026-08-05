// #826 — the ACTUAL user-visible defect: panel_request_secret answered
//
//   "Token saved for the built-in comfyui tools (env "CIVITAI_API_TOKEN").
//    It's being applied now — the comfyui tools respawn with it as soon as this
//    turn ends, then I'll retry. No reload needed."
//
// for every save, regardless of whether anything persisted or anything ever
// respawned. An agent following that answer retries, gets the identical 401, and
// loops — with nothing distinguishing "no token configured" from "valid token on
// disk that the tools cannot see".
//
// These tests pin the replacement text against the receipt it is built from. They
// assert the REASON, not merely that some string came back: an unverified save
// must not read as verified, an unreported respawn must not read as a scheduled
// one, and a save proven NOT to have landed must be a refusal that tells the
// caller not to retry.

import { describe, expect, it } from "vitest";
import {
  describeComfyuiSecretSave,
  secretNotPersisted,
  secretSavedReply,
} from "../../orchestrator/panel-tools.js";
import type { SecretSaveReceipt } from "../../services/panel-secrets.js";

const base: SecretSaveReceipt = {
  key: "CIVITAI_API_TOKEN",
  path: "/home/u/.comfyui-mcp/.env",
  persisted: "yes",
  livePickup: true,
  respawn: null,
};

describe("describeComfyuiSecretSave: says only what was observed (#826)", () => {
  it("states the save was VERIFIED by reading the file back", () => {
    const text = describeComfyuiSecretSave(base);
    expect(text).toContain("verified by reading the file back");
    expect(text).toContain("CIVITAI_API_TOKEN");
    expect(text).toContain("/home/u/.comfyui-mcp/.env");
  });

  it("never claims verification when persistence is UNKNOWN", () => {
    const text = describeComfyuiSecretSave({ ...base, persisted: "unknown" });
    expect(text).not.toContain("verified by reading the file back");
    expect(text).toContain("UNKNOWN");
    expect(text).toContain("unconfirmed");
  });

  it("makes NO live-pickup or retry-now claim when persistence is UNKNOWN", () => {
    // Every downstream claim rests on the value actually being in the store. A
    // running tool session falls back to the credential it started with when the
    // store is unreadable, so "it picks it up, retry now" would be a promise
    // about a state nobody observed.
    const text = describeComfyuiSecretSave({ ...base, persisted: "unknown", livePickup: true });
    expect(text).not.toContain("re-read that file each time");
    expect(text).not.toContain("no respawn required");
    expect(text).not.toContain("Retry the action that needed this credential now");
    expect(text).toContain("I cannot say the comfyui tools can see the new value");
    expect(text).toContain("falls back to the credential it started with");
    // ...and it still says what to do from here.
    expect(text).toContain("re-check");
    expect(text).toContain("treat the credential as unset");
  });

  it("never promises a respawn when NO subscriber reported one", () => {
    const text = describeComfyuiSecretSave({ ...base, respawn: null });
    // The old wording. It must be gone: it asserted a future event nobody checked.
    expect(text).not.toContain("respawn with it as soon as this turn ends");
    expect(text).toContain("NO tool-session respawn was scheduled");
  });

  it("describes a QUEUED replacement as queued, not as done", () => {
    const text = describeComfyuiSecretSave({
      ...base,
      respawn: { live: 1, applied: 0, scheduled: 1 },
    });
    expect(text).toContain("1 queued for the end of this turn");
    expect(text).not.toContain("1 replaced now");
  });

  it("describes an APPLIED replacement as already done", () => {
    const text = describeComfyuiSecretSave({
      ...base,
      respawn: { live: 2, applied: 2, scheduled: 0 },
    });
    expect(text).toContain("2 replaced now");
    expect(text).not.toContain("queued for the end of this turn");
  });

  it("reports both dispositions when a multi-tab change split them", () => {
    const text = describeComfyuiSecretSave({
      ...base,
      respawn: { live: 3, applied: 1, scheduled: 2 },
    });
    expect(text).toContain("1 replaced now");
    expect(text).toContain("2 queued for the end of this turn");
    expect(text).toContain("of 3 live");
  });

  it("says 'retry now' ONLY when the credential is picked up without a respawn", () => {
    expect(describeComfyuiSecretSave({ ...base, livePickup: true })).toContain(
      "Retry the action that needed this credential now",
    );
    const notLive = describeComfyuiSecretSave({ ...base, livePickup: false });
    expect(notLive).toContain("Retry after the tool session is rebuilt");
    expect(notLive).not.toContain("no respawn required");
  });

  it("explains WHY a live-pickup credential needs no reload (the file is re-read at use)", () => {
    const text = describeComfyuiSecretSave({ ...base, livePickup: true });
    expect(text).toContain("re-read that file each time they use this credential");
    expect(text).toContain("no respawn required");
  });

  it("LEADS with data loss and never narrates a save over it", () => {
    // "Your token is saved" while the user's other tokens were destroyed is a
    // fabricated success on top of data loss — the worst outcome in this
    // codebase's ranking, so it outranks every other clause in the ack.
    const text = describeComfyuiSecretSave({
      ...base,
      lostKeys: ["HF_TOKEN", "RUNPOD_API_KEY"],
      respawn: { live: 1, applied: 1, scheduled: 0 },
    });
    expect(text).toContain("NO LONGER carries HF_TOKEN, RUNPOD_API_KEY");
    expect(text).toContain("Do not treat this as a successful save");
    // None of the success narration survives.
    expect(text).not.toContain("verified by reading the file back");
    expect(text).not.toContain("Retry the action that needed this credential now");
    expect(text).not.toContain("replaced now");
  });

  it("says nothing about loss on a healthy save", () => {
    expect(describeComfyuiSecretSave(base)).not.toContain("NO LONGER carries");
  });

  it("never contains a secret value — the receipt carries none to leak", () => {
    const text = describeComfyuiSecretSave({
      ...base,
      respawn: { live: 1, applied: 1, scheduled: 0 },
    });
    expect(Object.values(base).join(" ")).not.toContain("civ-");
    expect(text).not.toMatch(/civ-|sk-|hf_/);
  });
});

describe("a FAILED save still discloses the damage it did on the way", () => {
  it("leads with the lost credentials and does NOT say 'set it again'", () => {
    // A save can fail to leave OUR key behind AND destroy other entries in the
    // same rewrite. Leading with "was NOT saved, set the key again" over that
    // hides completed damage and sends the user to write over an already-damaged
    // store (codex gate).
    const err = secretNotPersisted({
      ...base,
      persisted: "no",
      stillConfigured: false,
      lostKeys: ["HF_TOKEN", "RUNPOD_API_KEY"],
    });
    expect(err.message).toContain("NO LONGER carries HF_TOKEN, RUNPOD_API_KEY");
    expect(err.message).toContain("restore");
    expect(err.message).not.toContain("then set the key again");
    // The damage is stated BEFORE the "was NOT saved" headline.
    expect(err.message.indexOf("NO LONGER carries")).toBeLessThan(
      err.message.indexOf("was NOT saved"),
    );
  });

  it("keeps the ordinary retry advice when nothing else was lost", () => {
    const err = secretNotPersisted({ ...base, persisted: "no", stillConfigured: false });
    expect(err.message).toContain("then set the key again");
    expect(err.message).not.toContain("NO LONGER carries");
  });
});

describe("secretSavedReply: the panel's green light is the same question as everyone else's", () => {
  it("is ok ONLY for a proven, clean save", () => {
    expect(secretSavedReply(base).ok).toBe(true);
    expect(secretSavedReply({ ...base, persisted: "unknown" }).ok).toBe(false);
    expect(secretSavedReply({ ...base, persisted: "no" }).ok).toBe(false);
    expect(secretSavedReply({ ...base, persisted: "damaged", lostKeys: ["HF_TOKEN"] }).ok).toBe(
      false,
    );
  });

  it("never answers ok over DESTROYED credentials, and names them", () => {
    // The Settings-panel bridge route discarded the receipt and replied ok:true
    // whenever the call did not throw, so this exact receipt painted the panel
    // green over the user's lost HuggingFace token (codex gate).
    const reply = secretSavedReply({
      ...base,
      persisted: "damaged",
      lostKeys: ["HF_TOKEN", "RUNPOD_API_KEY"],
    });
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toContain("HF_TOKEN, RUNPOD_API_KEY");
    expect(String(reply.error)).toContain("Do not treat this as a successful save");
  });

  it("says WHAT was not established for an unverified save, not a fixed guess", () => {
    const reply = secretSavedReply({
      ...base,
      persisted: "unknown",
      uncertainty: "another process was writing the store during this save",
    });
    expect(reply.ok).toBe(false);
    expect(String(reply.error)).toContain("UNKNOWN");
    expect(String(reply.error)).toContain("another process was writing");
  });

  it("carries a confirmed save's remaining obligations as warnings", () => {
    const reply = secretSavedReply({ ...base, lostCommentLines: 2 });
    expect(reply.ok).toBe(true);
    expect(String(reply.warnings?.join(" "))).toContain("2 comment lines");
  });

  it("never contains a secret value", () => {
    const reply = secretSavedReply({ ...base, persisted: "damaged", lostKeys: ["HF_TOKEN"] });
    expect(JSON.stringify(reply)).not.toMatch(/civ-|sk-|hf_/);
  });
});

describe("secretNotPersisted: reflects whether a credential SURVIVED the rollback", () => {
  it("does NOT say 'nothing is configured' when a previous value is still in effect", () => {
    const err = secretNotPersisted({ ...base, persisted: "no", stillConfigured: true });
    expect(err.message).toContain("was NOT saved");
    expect(err.message).not.toContain("nothing is configured");
    expect(err.message).toContain("SOME credential for this key still resolves");
    // ...but it must NOT say WHICH. `stillConfigured` is a presence check; the
    // in-process value was rolled back and the store was not, so what resolves
    // may be the predecessor or a competing writer's value — asserting the
    // former is a state nobody observed (codex gate).
    expect(err.message).toContain("which one is not established");
    expect(err.message).not.toMatch(/the credential that was in place BEFORE this attempt is still in effect/);
    // And it must not be read as "now fixed" — whatever resolves is not the new value.
    expect(err.message).toContain('do not read this as "now fixed"');
  });

  it("does not tell the caller to skip retrying when a credential is still in effect", () => {
    const err = secretNotPersisted({ ...base, persisted: "no", stillConfigured: true });
    expect(err.message).not.toContain("do not retry the action that needed it");
  });
});

describe("secretNotPersisted: refuses, and says do NOT retry (#826)", () => {
  const err = secretNotPersisted({ ...base, persisted: "no", stillConfigured: false });

  it("is an error, not a success dressed as a warning", () => {
    expect(err).toBeInstanceOf(Error);
  });

  it("states plainly that nothing is configured, AND that the value was rolled back", () => {
    // The in-process assignment is undone before this error is raised, so
    // "nothing is configured" is a fact rather than a half-truth — without the
    // rollback the value would still be live in the orchestrator's env (and
    // injected into the next child) while the tool reported failure.
    expect(err.message).toContain("was NOT saved");
    expect(err.message).toContain("rolled back rather than left half-applied");
    expect(err.message).toContain("nothing is configured");
  });

  it("tells the caller NOT to retry the blocked action — the loop #826 reported", () => {
    expect(err.message).toContain("do not retry the action that needed it");
  });

  it("gives a remedy actionable from here: the file to check and how to set the key again", () => {
    expect(err.message).toContain("/home/u/.comfyui-mcp/.env");
    expect(err.message).toContain("writable");
    expect(err.message).toContain("set the key again");
  });

  it("names the key so the caller knows WHICH credential failed", () => {
    expect(err.message).toContain("CIVITAI_API_TOKEN");
  });
});
