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

  it("never contains a secret value — the receipt carries none to leak", () => {
    const text = describeComfyuiSecretSave({
      ...base,
      respawn: { live: 1, applied: 1, scheduled: 0 },
    });
    expect(Object.values(base).join(" ")).not.toContain("civ-");
    expect(text).not.toMatch(/civ-|sk-|hf_/);
  });
});

describe("secretNotPersisted: refuses, and says do NOT retry (#826)", () => {
  const err = secretNotPersisted({ ...base, persisted: "no" });

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
