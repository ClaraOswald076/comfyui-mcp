// #826 — panel_request_secret reported success while the credential never
// reached anything that could use it. The defect is not the failed injection; it
// is the FABRICATED success: the tool asserted "the comfyui tools respawn with it
// as soon as this turn ends" without observing a respawn, and asserted the save
// itself from the mere absence of a throw.
//
// These tests pin the receipt that replaced the assertion. Every field must be a
// thing that was checked: whether a read-back of the canonical file shows the
// key, whether any subscriber actually reported a respawn, and whether the value
// is picked up without one. A subscriber that says nothing must produce `null`
// (unknown), never a zero that reads as "checked, nothing needed".
//
// Nothing here logs a secret value; the receipt itself never carries one.

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The read-back is what makes "saved" an observation instead of an assumption,
// so the tests must be able to make the store DISAGREE with the write (a
// concurrent writer, a read-only overlay, a filesystem that discarded it) and to
// make it UNREADABLE. Both are properties of parseEnvFile, mocked here with a
// pass-through default so every other test still exercises the real store.
const store = vi.hoisted(() => ({ mode: "real" as "real" | "drop" | "tamper" | "unreadable" }));
vi.mock("../../env-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../env-file.js")>();
  return {
    ...actual,
    parseEnvFile: () => {
      if (store.mode === "unreadable") return null;
      const real = actual.parseEnvFile();
      if (!real || store.mode === "real") return real;
      const copy = { ...real };
      if (store.mode === "drop") delete copy.CIVITAI_API_TOKEN;
      else copy.CIVITAI_API_TOKEN = "somebody-elses-value";
      return copy;
    },
  };
});

import {
  buildComfyuiMcpEnv,
  hasLivePickup,
  onComfyuiSecretsChanged,
  setAgentSecret,
  setComfyuiSecret,
  COMFYUI_SECRET_ENV_ALLOWLIST,
  AGENT_SECRET_ENV_ALLOWLIST,
  type SecretRespawnReport,
} from "../../services/panel-secrets.js";
import { MANAGED_SECRET_KEYS_ENV } from "../../env-file.js";

const ALL_KEYS = [...new Set([...COMFYUI_SECRET_ENV_ALLOWLIST, ...AGENT_SECRET_ENV_ALLOWLIST])];

let dir: string;
let envPath: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  store.mode = "real";
  dir = mkdtempSync(join(tmpdir(), "cmcp-receipt-"));
  envPath = join(dir, ".env");
  process.env.COMFYUI_MCP_ENV_FILE = envPath;
  saved = {};
  for (const k of ALL_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  store.mode = "real";
  delete process.env.COMFYUI_MCP_ENV_FILE;
  for (const k of ALL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("secret save receipt: persistence is VERIFIED, not assumed (#826)", () => {
  it("reports persisted:'yes' only after a read-back of the canonical file agrees", () => {
    const receipt = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc", { requested: true });
    expect(receipt.persisted).toBe("yes");
    expect(receipt.key).toBe("CIVITAI_API_TOKEN");
    expect(receipt.path).toBe(envPath);
  });

  it("reports persisted:'no' when the store does NOT come back carrying the key", () => {
    // The write call returned normally — the OLD code called that success. The
    // read-back proves the store does not have it, so the save did not take
    // effect and the caller must refuse rather than send the user back into the
    // same 401 believing it is fixed.
    store.mode = "drop";
    expect(setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc").persisted).toBe("no");
  });

  it("reports persisted:'no' when the store carries the key with a DIFFERENT value", () => {
    // Same-key/other-value is the dangerous near-miss: a presence-only check would
    // read as success while the tools go on using somebody else's credential.
    store.mode = "tamper";
    expect(setComfyuiSecret("CIVITAI_API_TOKEN", "civ-second").persisted).toBe("no");
  });

  it("reports persisted:'unknown' when the store cannot be re-read at all", () => {
    // "Could not determine" must stay undetermined — it may never harden into
    // either verdict, in either direction.
    store.mode = "unreadable";
    expect(setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc").persisted).toBe("unknown");
  });

  it("ROLLS BACK process.env on persisted:'no', so 'nothing is configured' is true", () => {
    // Without the rollback the value stayed live in the orchestrator's env — and
    // would be injected into the next child's spawn env — while the tool
    // reported failure and told the caller not to retry: the opposite false
    // verdict to #826, and just as misleading.
    expect(process.env.CIVITAI_API_TOKEN).toBeUndefined();
    store.mode = "drop";
    expect(setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc").persisted).toBe("no");
    expect(process.env.CIVITAI_API_TOKEN).toBeUndefined();
    expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBeUndefined();
  });

  it("restores the PREVIOUS value on persisted:'no' rather than clearing a working one", () => {
    store.mode = "real";
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-working");
    expect(process.env.CIVITAI_API_TOKEN).toBe("civ-working");
    store.mode = "drop";
    expect(setComfyuiSecret("CIVITAI_API_TOKEN", "civ-broken").persisted).toBe("no");
    expect(process.env.CIVITAI_API_TOKEN).toBe("civ-working");
  });

  it("emits NO change event on persisted:'no' — a failed save must set nothing in motion", () => {
    const cb = vi.fn();
    const off = onComfyuiSecretsChanged(cb);
    try {
      store.mode = "drop";
      const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc", { requested: true });
      expect(r.persisted).toBe("no");
      expect(r.respawn).toBeNull();
      expect(cb).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});

describe("secret values must survive the dotenv round trip, or be refused (#826 gate)", () => {
  it("stores a value containing spaces and reads it back identically", () => {
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "a token with spaces");
    expect(r.persisted).toBe("yes");
    expect(process.env.CIVITAI_API_TOKEN).toBe("a token with spaces");
  });

  it("stores a value containing a hash, a quote or a backslash without corrupting it", () => {
    for (const v of ['tok#1', 'tok"quoted', "tok\\back\\slash", "tok'single"]) {
      const r = setComfyuiSecret("CIVITAI_API_TOKEN", v);
      expect(r.persisted).toBe("yes");
      expect(process.env.CIVITAI_API_TOKEN).toBe(v);
    }
  });

  it("REFUSES a value it cannot represent, rather than writing something different", () => {
    // A value carrying both quote flavours plus a backslash has no faithful
    // dotenv encoding. Storing a mangled copy would be the worst outcome: the
    // save reports success and every request authenticates with the wrong token.
    expect(() => setComfyuiSecret("CIVITAI_API_TOKEN", `a'b"c\\d`)).toThrow(
      /cannot be stored faithfully/,
    );
    // ...and it says how to proceed from here.
    expect(() => setComfyuiSecret("CIVITAI_API_TOKEN", `a'b"c\\d`)).toThrow(
      /real environment variable/,
    );
  });

  it("never includes the value in the refusal", () => {
    try {
      setComfyuiSecret("CIVITAI_API_TOKEN", `secret'value"with\\everything`);
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as Error).message).not.toContain("secret");
    }
  });
});

describe("secret save receipt: respawn is REPORTED, never assumed (#826)", () => {
  it("reports respawn:null when NO subscriber answered — silence is not success", () => {
    const receipt = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc", { requested: true });
    expect(receipt.respawn).toBeNull();
  });

  it("carries exactly what the subscriber reported (applied vs scheduled vs live)", () => {
    const off = onComfyuiSecretsChanged((change) => {
      change.report?.({ live: 3, applied: 1, scheduled: 2 });
    });
    try {
      const receipt = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc", { requested: true });
      expect(receipt.respawn).toEqual<SecretRespawnReport>({ live: 3, applied: 1, scheduled: 2 });
    } finally {
      off();
    }
  });

  it("sums multiple subscribers rather than letting the last one overwrite", () => {
    const offA = onComfyuiSecretsChanged((c) => c.report?.({ live: 1, applied: 1, scheduled: 0 }));
    const offB = onComfyuiSecretsChanged((c) => c.report?.({ live: 2, applied: 0, scheduled: 2 }));
    try {
      const receipt = setComfyuiSecret("HF_TOKEN", "hf-abc", { requested: true });
      expect(receipt.respawn).toEqual({ live: 3, applied: 1, scheduled: 2 });
    } finally {
      offA();
      offB();
    }
  });

  it("stays null when a subscriber exists but reports NOTHING — an unanswered listener proves nothing", () => {
    const off = onComfyuiSecretsChanged(() => {
      /* subscribes, does no respawn work, reports nothing */
    });
    try {
      expect(setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc").respawn).toBeNull();
    } finally {
      off();
    }
  });

  it("collects the report SYNCHRONOUSLY, so the saver can answer with it", () => {
    // The whole design depends on emit() being synchronous. If a subscriber's
    // report landed after setComfyuiSecret returned, the receipt would always say
    // "no subscriber" and the tool would be back to guessing.
    let reportedDuringCall = false;
    const off = onComfyuiSecretsChanged((c) => {
      reportedDuringCall = true;
      c.report?.({ live: 1, applied: 0, scheduled: 1 });
    });
    try {
      const receipt = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc");
      expect(reportedDuringCall).toBe(true);
      expect(receipt.respawn).not.toBeNull();
    } finally {
      off();
    }
  });

  it("does not fire the comfyui change (nor collect a report) for an AGENT-only key", () => {
    const cb = vi.fn();
    const off = onComfyuiSecretsChanged(cb);
    try {
      setAgentSecret("OPENROUTER_API_KEY", "or-abc");
      expect(cb).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});

describe("secret save receipt: livePickup describes the ACTUAL read path", () => {
  it("marks the child-side credentials as live (their readers re-read the file)", () => {
    for (const k of [
      "CIVITAI_API_TOKEN",
      "HF_TOKEN",
      "HUGGINGFACE_TOKEN",
      "RUNPOD_API_KEY",
      "REGISTRY_ACCESS_TOKEN",
    ]) {
      expect(hasLivePickup(k)).toBe(true);
    }
    expect(setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc").livePickup).toBe(true);
  });

  it("does NOT claim live pickup for keys a running SUBPROCESS still holds", () => {
    // GEMINI_API_KEY / GOOGLE_* are forwarded into the Gemini CLI subprocess's
    // spawn env, and OPENROUTER/GLM-style keys are captured by keyed backends at
    // construction (#278). Both keep the OLD value until respawned, so claiming
    // a live pickup for them would be the #826 defect in miniature.
    expect(hasLivePickup("GEMINI_API_KEY")).toBe(false);
    expect(hasLivePickup("GOOGLE_API_KEY")).toBe(false);
    expect(hasLivePickup("OPENROUTER_API_KEY")).toBe(false);
  });

  it("does NOT claim live pickup for a key nothing is known to re-read", () => {
    expect(hasLivePickup("RUNCOMFY_API_KEY")).toBe(false);
    expect(hasLivePickup("SOME_UNRELATED_KEY")).toBe(false);
  });
});

describe("buildComfyuiMcpEnv pins the credential file into the child (#826)", () => {
  it("forwards COMFYUI_MCP_ENV_FILE so writer and reader cannot be different files", () => {
    const env = buildComfyuiMcpEnv({ COMFYUI_URL: "http://x" });
    expect(env.COMFYUI_MCP_ENV_FILE).toBe(envPath);
  });

  it("omits it entirely when unset, leaving the child on the default path", () => {
    delete process.env.COMFYUI_MCP_ENV_FILE;
    const env = buildComfyuiMcpEnv({ COMFYUI_URL: "http://x" });
    expect("COMFYUI_MCP_ENV_FILE" in env).toBe(false);
  });

  it("still lets a saved secret win over the base env on a key clash", () => {
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    const env = buildComfyuiMcpEnv({ CIVITAI_API_TOKEN: "civ-base", COMFYUI_URL: "http://x" });
    expect(env.CIVITAI_API_TOKEN).toBe("civ-new");
  });

  it("marks an injected credential the FILE owns, so a later rotate supersedes it in the child", () => {
    // Without the marker the child sees the injected copy as a real environment
    // variable and pins it for its whole life — a rotate or revoke is ignored
    // while the save reports that the running tools re-read the file.
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-managed");
    const env = buildComfyuiMcpEnv({ COMFYUI_URL: "http://x" });
    expect(env[MANAGED_SECRET_KEYS_ENV]?.split(",")).toContain("CIVITAI_API_TOKEN");
    // KEY NAMES only — the marker must never carry a value.
    expect(env[MANAGED_SECRET_KEYS_ENV]).not.toContain("civ-managed");
  });

  it("does NOT mark a shell-only credential, so the child keeps the escape hatch pinned", () => {
    // The file does not carry this value, so the canonical store is not its
    // authority — marking it would let an unrelated file entry override the
    // user's explicit environment variable.
    process.env.HF_TOKEN = "hf-from-shell";
    const env = buildComfyuiMcpEnv({ COMFYUI_URL: "http://x" });
    expect(env.HF_TOKEN).toBe("hf-from-shell");
    expect(env[MANAGED_SECRET_KEYS_ENV]?.split(",") ?? []).not.toContain("HF_TOKEN");
  });

  it("omits the marker entirely when no credential is file-owned", () => {
    const env = buildComfyuiMcpEnv({ COMFYUI_URL: "http://x" });
    expect(MANAGED_SECRET_KEYS_ENV in env).toBe(false);
  });
});
