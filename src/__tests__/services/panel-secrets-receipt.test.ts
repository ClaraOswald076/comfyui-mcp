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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The read-back is what makes "saved" an observation instead of an assumption,
// so the tests must be able to reproduce the case it exists for: the write call
// RETURNS NORMALLY and the store does not end up carrying the value (a read-only
// overlay, a filesystem that discarded it, another process rewriting the file).
// That is modelled at the lowest honest level — writeFileSync becomes a no-op —
// so the ENTIRE real read-back path runs, including env-file's own internal file
// read, which a module-level mock of parseEnvFile would not intercept.
const fsState = vi.hoisted(() => ({
  /** The write returns normally but the store never takes it. */
  swallowWrites: false,
  /** The write lands, then the store becomes unreadable — so the read-back
   *  cannot reach a verdict either way. */
  breakReadsAfterWrite: false,
  readsBroken: false,
  /** Swallow only SOME writes — used to fail one alias of a slot fan-out. */
  failWriteOnCall: null as null | (() => boolean),
  /** Once this many writes have completed, arm `breakNextReads` failing reads —
   *  so a restore's WRITE can land while only its verification read fails, which
   *  is exactly the case where a restore is genuinely unverifiable. */
  breakReadsAfterWriteCount: null as number | null,
  breakNextReads: 0,
  writeCount: 0,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const writeFileSync: typeof actual.writeFileSync = (...args) => {
    if (fsState.swallowWrites) return;
    if (fsState.failWriteOnCall?.()) return; // this write silently does not land
    const out = actual.writeFileSync(...args);
    fsState.writeCount++;
    if (fsState.breakReadsAfterWrite) fsState.readsBroken = true;
    if (
      fsState.breakReadsAfterWriteCount !== null &&
      fsState.writeCount === fsState.breakReadsAfterWriteCount
    ) {
      fsState.breakNextReads = 2; // the setter's read-back, then the restore check
    }
    return out;
  };
  const readFileSync: typeof actual.readFileSync = ((...args: Parameters<typeof actual.readFileSync>) => {
    if (String(args[0]).endsWith(".env")) {
      if (fsState.readsBroken) {
        throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      }
      if (fsState.breakNextReads > 0) {
        fsState.breakNextReads--;
        throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
      }
    }
    return actual.readFileSync(...args);
  }) as typeof actual.readFileSync;
  return {
    ...actual,
    default: { ...actual, writeFileSync, readFileSync },
    writeFileSync,
    readFileSync,
  };
});

import {
  buildComfyuiMcpEnv,
  clearPanelSecret,
  hasLivePickup,
  listPanelSecretsMasked,
  maskSecret,
  migrateSecretsToEnv,
  onComfyuiSecretsChanged,
  panelSecretsPath,
  removeComfyuiSecret,
  setAgentSecret,
  setComfyuiSecret,
  setPanelSecret,
  slotRevokeState,
  slotSaveConfirmed,
  slotShellProvidedKeys,
  slotStillResolves,
  unconfirmedSlotKeys,
  COMFYUI_SECRET_ENV_ALLOWLIST,
  AGENT_SECRET_ENV_ALLOWLIST,
  type SecretRespawnReport,
} from "../../services/panel-secrets.js";
import {
  resetEnvFileProvenanceForTests,
  MANAGED_SECRET_KEYS_ENV,
} from "../../env-file.js";

const ALL_KEYS = [...new Set([...COMFYUI_SECRET_ENV_ALLOWLIST, ...AGENT_SECRET_ENV_ALLOWLIST])];

let dir: string;
let envPath: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  fsState.swallowWrites = false;
  fsState.breakReadsAfterWrite = false;
  fsState.readsBroken = false;
  fsState.failWriteOnCall = null;
  fsState.breakReadsAfterWriteCount = null;
  fsState.breakNextReads = 0;
  fsState.writeCount = 0;
  dir = mkdtempSync(join(tmpdir(), "cmcp-receipt-"));
  envPath = join(dir, ".env");
  process.env.COMFYUI_MCP_ENV_FILE = envPath;
  // Isolate the legacy JSON store too — migrateSecretsToEnv reads it.
  process.env.COMFYUI_MCP_PANEL_SECRETS = join(dir, "panel-secrets.json");
  saved = {};
  for (const k of ALL_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  // The file-derived marks are module-global; without this a key marked by an
  // earlier test would still count as file-owned here.
  resetEnvFileProvenanceForTests();
});

afterEach(() => {
  fsState.swallowWrites = false;
  fsState.breakReadsAfterWrite = false;
  fsState.readsBroken = false;
  fsState.failWriteOnCall = null;
  fsState.breakReadsAfterWriteCount = null;
  fsState.breakNextReads = 0;
  fsState.writeCount = 0;
  delete process.env.COMFYUI_MCP_ENV_FILE;
  delete process.env.COMFYUI_MCP_PANEL_SECRETS;
  for (const k of ALL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvFileProvenanceForTests();
  rmSync(dir, { recursive: true, force: true });
});

/** Reproduce "the write returned normally, the store did not take it". The store
 *  must EXIST for this to be a "no" rather than an "unknown" — an absent file
 *  means we could not determine anything, which is a different verdict. */
function withSwallowedWrites<T>(fn: () => T): T {
  if (!existsSync(envPath)) writeFileSync(envPath, "# store exists but is empty\n", { mode: 0o600 });
  fsState.swallowWrites = true;
  try {
    return fn();
  } finally {
    fsState.swallowWrites = false;
  }
}

/** Reproduce "the write landed, then the store could not be re-read". */
function withUnreadableReadBack<T>(fn: () => T): T {
  fsState.breakReadsAfterWrite = true;
  try {
    return fn();
  } finally {
    fsState.breakReadsAfterWrite = false;
    fsState.readsBroken = false;
  }
}

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
    const r = withSwallowedWrites(() => setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc"));
    expect(r.persisted).toBe("no");
  });

  it("reports persisted:'no' when the store carries the key with a DIFFERENT value", () => {
    // Same-key/other-value is the dangerous near-miss: a presence-only check would
    // read as success while the tools go on using somebody else's credential.
    writeFileSync(envPath, "CIVITAI_API_TOKEN=somebody-elses-value\n", { mode: 0o600 });
    const r = withSwallowedWrites(() => setComfyuiSecret("CIVITAI_API_TOKEN", "civ-second"));
    expect(r.persisted).toBe("no");
  });

  it("reports persisted:'unknown' when the store cannot be re-read at all", () => {
    // "Could not determine" must stay undetermined — it may never harden into
    // either verdict, in either direction.
    const r = withUnreadableReadBack(() => setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc"));
    expect(r.persisted).toBe("unknown");
  });

  it("does NOT roll back on 'unknown' — the value may well be in place", () => {
    // Refusing after an action that may have succeeded is its own error. An
    // unverifiable save is DISCLOSED, not undone.
    const r = withUnreadableReadBack(() => setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc"));
    expect(r.persisted).toBe("unknown");
    expect(process.env.CIVITAI_API_TOKEN).toBe("civ-abc");
  });

  it("ROLLS BACK process.env on persisted:'no', so 'nothing is configured' is true", () => {
    // Without the rollback the value stayed live in the orchestrator's env — and
    // would be injected into the next child's spawn env — while the tool
    // reported failure and told the caller not to retry: the opposite false
    // verdict to #826, and just as misleading.
    expect(process.env.CIVITAI_API_TOKEN).toBeUndefined();
    const r = withSwallowedWrites(() => setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc"));
    expect(r.persisted).toBe("no");
    expect(process.env.CIVITAI_API_TOKEN).toBeUndefined();
    expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBeUndefined();
  });

  it("restores the PREVIOUS value on persisted:'no' rather than clearing a working one", () => {
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-working");
    expect(process.env.CIVITAI_API_TOKEN).toBe("civ-working");
    const r = withSwallowedWrites(() => setComfyuiSecret("CIVITAI_API_TOKEN", "civ-broken"));
    expect(r.persisted).toBe("no");
    expect(process.env.CIVITAI_API_TOKEN).toBe("civ-working");
  });

  it("restores the previous value's PRECEDENCE too, not just its text", () => {
    // The save marks the key file-derived (the file becomes its authority). A
    // rollback must undo that as well, or a SHELL-provided credential silently
    // becomes overridable by the file from then on — the failed save would have
    // changed how a value it did not store resolves.
    process.env.CIVITAI_API_TOKEN = "civ-from-shell";
    writeFileSync(envPath, "# empty\n", { mode: 0o600 });
    const r = withSwallowedWrites(() => setComfyuiSecret("CIVITAI_API_TOKEN", "civ-broken"));
    expect(r.persisted).toBe("no");
    expect(process.env.CIVITAI_API_TOKEN).toBe("civ-from-shell");
    // The file now names a different value; the shell one must still win.
    writeFileSync(envPath, "CIVITAI_API_TOKEN=civ-from-file\n", { mode: 0o600 });
    expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBe("civ-from-shell");
  });

  it("emits NO change event on persisted:'no' — a failed save must set nothing in motion", () => {
    const cb = vi.fn();
    const off = onComfyuiSecretsChanged(cb);
    try {
      const r = withSwallowedWrites(() =>
        setComfyuiSecret("CIVITAI_API_TOKEN", "civ-abc", { requested: true }),
      );
      expect(r.persisted).toBe("no");
      expect(r.respawn).toBeNull();
      expect(cb).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });
});

describe("`export KEY=` lines are the SAME key (#826 gate round 3)", () => {
  it("a revoke removes the export form too, so the credential really is gone", () => {
    // dotenv honours `export KEY=…`. Matching only `KEY=` removed the plain line
    // and left the exported one supplying the old credential, while the revoke
    // reported the slot cleared.
    writeFileSync(envPath, "export CIVITAI_API_TOKEN=old-exported\n", { mode: 0o600 });
    expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBe("old-exported");
    expect(removeComfyuiSecret("CIVITAI_API_TOKEN")).toBe(true);
    expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBeUndefined();
    expect(readFileSync(envPath, "utf-8")).not.toContain("old-exported");
  });

  it("a revoke removes the COLON form dotenv also accepts", () => {
    writeFileSync(envPath, "CIVITAI_API_TOKEN: old-colon\n", { mode: 0o600 });
    expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBe("old-colon");
    expect(removeComfyuiSecret("CIVITAI_API_TOKEN")).toBe(true);
    expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBeUndefined();
  });

  it("a save REPLACES the colon form instead of appending a second assignment", () => {
    writeFileSync(envPath, "CIVITAI_API_TOKEN: old-colon\n", { mode: 0o600 });
    expect(setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new").persisted).toBe("yes");
    expect(readFileSync(envPath, "utf-8")).not.toContain("old-colon");
    delete process.env.CIVITAI_API_TOKEN;
    expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBe("civ-new");
  });

  it("does NOT treat a DIFFERENT key that merely starts with this one as the same key", () => {
    writeFileSync(envPath, "HF_TOKEN_EXTRA=keep-me\nHF_TOKEN=replace-me\n", { mode: 0o600 });
    setComfyuiSecret("HF_TOKEN", "hf-new");
    const raw = readFileSync(envPath, "utf-8");
    expect(raw).toContain("HF_TOKEN_EXTRA=keep-me");
    expect(raw).not.toContain("replace-me");
  });

  it("a save REPLACES the export form instead of appending a second assignment", () => {
    writeFileSync(envPath, "export CIVITAI_API_TOKEN=old-exported\n", { mode: 0o600 });
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    expect(r.persisted).toBe("yes");
    const raw = readFileSync(envPath, "utf-8");
    expect(raw).not.toContain("old-exported");
    expect(raw.match(/CIVITAI_API_TOKEN\s*=/g)).toHaveLength(1);
    delete process.env.CIVITAI_API_TOKEN;
    expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBe("civ-new");
  });
});

describe("a MIGRATED legacy token keeps the file as its authority (#826 gate round 3)", () => {
  it("marks a migrated key managed, so the child re-reads instead of pinning it", () => {
    // migrateSecretsToEnv writes the file and assigns process.env. Without the
    // provenance mark the value reads as SHELL-provided, gets injected unmarked,
    // and the child pins it — a later rotate/revoke invisible to that child even
    // though the save reports live pickup.
    writeFileSync(
      panelSecretsPath(),
      JSON.stringify({ comfyuiEnv: { CIVITAI_API_TOKEN: "legacy-token" } }),
      { mode: 0o600 },
    );
    expect(migrateSecretsToEnv()).toContain("CIVITAI_API_TOKEN");
    const env = buildComfyuiMcpEnv({});
    expect(env.CIVITAI_API_TOKEN).toBe("legacy-token");
    expect(env[MANAGED_SECRET_KEYS_ENV]?.split(",")).toContain("CIVITAI_API_TOKEN");
  });
});

describe("slot saves report what the read-back PROVED (#826 gate round 3)", () => {
  it("returns one receipt per alias key of the slot", () => {
    const outcome = setPanelSecret("huggingface", "hf-abc");
    expect(outcome.receipts.map((r) => r.key)).toEqual(["HF_TOKEN", "HUGGINGFACE_TOKEN"]);
    expect(slotSaveConfirmed(outcome)).toBe(true);
    expect(unconfirmedSlotKeys(outcome.receipts)).toEqual([]);
  });

  it("is NOT confirmed when the store does not come back carrying the keys", () => {
    const outcome = withSwallowedWrites(() => setPanelSecret("civitai", "civ-abc"));
    expect(slotSaveConfirmed(outcome)).toBe(false);
    expect(unconfirmedSlotKeys(outcome.receipts)).toEqual([
      { key: "CIVITAI_API_TOKEN", persisted: "no" },
    ]);
  });

  it("treats an unverifiable save as unconfirmed rather than failed", () => {
    const outcome = withUnreadableReadBack(() => setPanelSecret("civitai", "civ-abc"));
    expect(slotSaveConfirmed(outcome)).toBe(false);
    expect(unconfirmedSlotKeys(outcome.receipts)).toEqual([
      { key: "CIVITAI_API_TOKEN", persisted: "unknown" },
    ]);
  });

  it("stops at the FIRST unconfirmed alias instead of layering more unverified writes", () => {
    const outcome = withSwallowedWrites(() => setPanelSecret("huggingface", "hf-abc"));
    expect(outcome.confirmed).toBe(false);
    expect(outcome.receipts.map((r) => r.key)).toEqual(["HF_TOKEN"]);
  });

  it("ROLLS BACK an alias that DID land when a later alias fails", () => {
    // The fan-out is serial, so HF_TOKEN can land and HUGGINGFACE_TOKEN fail.
    // Leaving the first alias live while reporting failure — and claiming
    // nothing was half-applied — is the round-4 defect.
    setPanelSecret("huggingface", "hf-old");
    let call = 0;
    const realWrite = writeFileSync;
    expect(typeof realWrite).toBe("function");
    // Fail only the SECOND alias's write.
    fsState.failWriteOnCall = () => ++call === 2;
    let outcome: ReturnType<typeof setPanelSecret>;
    try {
      outcome = setPanelSecret("huggingface", "hf-new");
    } finally {
      fsState.failWriteOnCall = null;
    }
    expect(outcome.confirmed).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.strandedKeys).toEqual([]);
    // Both aliases are back on the PREVIOUS value — neither is half-applied.
    const env = buildComfyuiMcpEnv({});
    expect(env.HF_TOKEN).toBe("hf-old");
    expect(env.HUGGINGFACE_TOKEN).toBe("hf-old");
  });

  it("leaves NO alias carrying the new value when the slot had none before", () => {
    let call = 0;
    fsState.failWriteOnCall = () => ++call === 2;
    let outcome: ReturnType<typeof setPanelSecret>;
    try {
      outcome = setPanelSecret("huggingface", "hf-new");
    } finally {
      fsState.failWriteOnCall = null;
    }
    expect(outcome.confirmed).toBe(false);
    expect(outcome.rolledBack).toBe(true);
    const env = buildComfyuiMcpEnv({});
    expect(env.HF_TOKEN).toBeUndefined();
    expect(env.HUGGINGFACE_TOKEN).toBeUndefined();
  });

  it("does NOT claim a clean rollback when the restore could not be verified", () => {
    // freshSecretValue falls back to the in-process copy when the store is
    // unreadable, so comparing against it would "confirm" a restore that never
    // reached disk. The verdict must come from the store, and stay UNKNOWN when
    // the store cannot be read.
    setPanelSecret("huggingface", "hf-old"); // writes 1 and 2
    let call = 0;
    // Fail the SECOND alias of the new save, then let the FIRST alias's restore
    // write land and break reads immediately afterwards — so the restore itself
    // succeeded but cannot be verified.
    fsState.failWriteOnCall = () => ++call === 2;
    fsState.breakReadsAfterWriteCount = 4;
    let outcome: ReturnType<typeof setPanelSecret>;
    try {
      outcome = setPanelSecret("huggingface", "hf-new");
    } finally {
      fsState.failWriteOnCall = null;
      fsState.breakReadsAfterWriteCount = null;
      fsState.readsBroken = false;
    }
    expect(outcome.confirmed).toBe(false);
    expect(outcome.unverifiedKeys).toContain("HF_TOKEN");
    // NOT a clean rollback: an UNPROVEN restore is not a proven one, and
    // `rolledBack` is what the caller turns into "nothing was half-applied".
    expect(outcome.strandedKeys).toEqual([]);
    expect(outcome.rolledBack).toBe(false);
  });

  it("restores a SHELL-provided previous value without persisting it into the store", () => {
    // Writing a shell secret back through the setter would move it into the
    // file and mark it file-derived: the text is restored, but where the value
    // lives and how it resolves are silently changed.
    resetEnvFileProvenanceForTests();
    process.env.HF_TOKEN = "hf-from-shell";
    process.env.HUGGINGFACE_TOKEN = "hf-from-shell";
    writeFileSync(envPath, "# store starts empty\n", { mode: 0o600 });
    let call = 0;
    fsState.failWriteOnCall = () => ++call === 2;
    try {
      setPanelSecret("huggingface", "hf-new");
    } finally {
      fsState.failWriteOnCall = null;
    }
    // Restored in the environment...
    expect(process.env.HF_TOKEN).toBe("hf-from-shell");
    // ...but NOT written into the credential store, and still shell-provided.
    expect(readFileSync(envPath, "utf-8")).not.toContain("hf-from-shell");
    expect(slotShellProvidedKeys("huggingface")).toContain("HF_TOKEN");
  });

  it("fires NO change event for a slot save that failed and was rolled back", () => {
    // Each successful alias used to emit before the later alias's failure was
    // known, so a save that ultimately failed still respawned every idle agent —
    // and the rollback respawned them all again.
    setPanelSecret("huggingface", "hf-old");
    const cb = vi.fn();
    const off = onComfyuiSecretsChanged(cb);
    try {
      let call = 0;
      fsState.failWriteOnCall = () => ++call === 2;
      try {
        const outcome = setPanelSecret("huggingface", "hf-new");
        expect(outcome.rolledBack).toBe(true);
      } finally {
        fsState.failWriteOnCall = null;
      }
      expect(cb).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("fires EXACTLY ONE change event for a successful multi-alias slot save", () => {
    const cb = vi.fn();
    const off = onComfyuiSecretsChanged(cb);
    try {
      expect(setPanelSecret("huggingface", "hf-abc").confirmed).toBe(true);
      expect(cb).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
  });

  it("restores the earlier alias before re-throwing a per-key validation failure", () => {
    // A control character is rejected per key. The FIRST alias would already
    // have been written when the second is rejected, so the throw must not leave
    // the slot half-updated.
    setPanelSecret("huggingface", "hf-old");
    const badValue = `hf-${String.fromCharCode(0)}-new`;
    expect(() => setPanelSecret("huggingface", badValue)).toThrow(/control character/);
    const env = buildComfyuiMcpEnv({});
    expect(env.HF_TOKEN).toBe("hf-old");
    expect(env.HUGGINGFACE_TOKEN).toBe("hf-old");
  });

  it("slotStillResolves proves a revoke actually took effect", () => {
    setPanelSecret("civitai", "civ-abc");
    expect(slotStillResolves("civitai")).toBe(true);
    clearPanelSecret("civitai");
    expect(slotStillResolves("civitai")).toBe(false);
  });

  it("names the slot keys a REAL env var supplies, so a revoke is not called permanent", () => {
    // This store can delete a shell-set credential from THIS process but not from
    // the environment the process was started with — it returns on the next
    // start. Reporting an unqualified "revoked" would claim a state never reached.
    process.env.CIVITAI_API_TOKEN = "civ-from-shell";
    expect(slotShellProvidedKeys("civitai")).toEqual(["CIVITAI_API_TOKEN"]);
    clearPanelSecret("civitai");
    // The clear DID take effect for this process...
    expect(slotStillResolves("civitai")).toBe(false);
  });

  it("reports the revoke state as UNKNOWN when the store cannot be re-read", () => {
    // After a revoke deletes this process's copy, an unreadable store makes
    // every alias resolve to undefined — which reads as "gone" while a child
    // that CAN read the file still finds the old credential there.
    setPanelSecret("civitai", "civ-abc");
    expect(slotRevokeState("civitai")).toBe("still-resolves");
    clearPanelSecret("civitai");
    expect(slotRevokeState("civitai")).toBe("gone");
    fsState.readsBroken = true;
    try {
      expect(slotRevokeState("civitai")).toBe("unknown");
    } finally {
      fsState.readsBroken = false;
    }
  });

  it("EMITS a change when only the in-process copy was dropped (a shell-only revoke)", () => {
    // A shell-provided key has no line in the store, so gating the emit on "a
    // line was removed" meant no child was ever respawned — a live tool session
    // kept using the credential the user had just revoked, while the console
    // reported it no longer resolves. The respawn is what removes it from the
    // child's env, so the event must fire.
    resetEnvFileProvenanceForTests();
    process.env.CIVITAI_API_TOKEN = "civ-from-shell";
    const cb = vi.fn();
    const off = onComfyuiSecretsChanged(cb);
    try {
      expect(removeComfyuiSecret("CIVITAI_API_TOKEN")).toBe(true);
      expect(cb).toHaveBeenCalledTimes(1);
      expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBeUndefined();
    } finally {
      off();
    }
  });

  it("emits NOTHING when there was no credential to remove at all", () => {
    const cb = vi.fn();
    const off = onComfyuiSecretsChanged(cb);
    try {
      expect(removeComfyuiSecret("CIVITAI_API_TOKEN")).toBe(false);
      expect(cb).not.toHaveBeenCalled();
    } finally {
      off();
    }
  });

  it("reports 'still-resolves' when the store still carries an alias", () => {
    writeFileSync(envPath, "CIVITAI_API_TOKEN=left-behind\n", { mode: 0o600 });
    expect(slotRevokeState("civitai")).toBe("still-resolves");
  });

  it("names NO shell keys for a credential this store owns", () => {
    setPanelSecret("civitai", "civ-abc");
    expect(slotShellProvidedKeys("civitai")).toEqual([]);
  });

  it("masks the value a READER would use, not whichever alias it checks first", () => {
    // The CANONICAL alias wins over the legacy one whichever side it came from,
    // so a freshly saved HF_TOKEN outranks a pre-existing shell
    // HUGGINGFACE_TOKEN — and the mask must show the same value the readers
    // resolve. (Resolving each alias independently and taking the first, or
    // preferring any shell alias over any file alias, would display a token
    // consumers are not using.)
    resetEnvFileProvenanceForTests();
    process.env.HUGGINGFACE_TOKEN = "shell-legacy-value";
    writeFileSync(envPath, "HF_TOKEN=file-canonical-value\n", { mode: 0o600 });
    const hf = listPanelSecretsMasked().find((s) => s.id === "huggingface")!;
    expect(hf.set).toBe(true);
    expect(hf.masked).toBe(maskSecret("file-canonical-value"));
    expect(hf.masked).not.toBe(maskSecret("shell-legacy-value"));
  });

  it("keeps the shell escape hatch WITHIN an alias — a real HF_TOKEN beats the file's", () => {
    resetEnvFileProvenanceForTests();
    process.env.HF_TOKEN = "shell-canonical-value";
    writeFileSync(envPath, "HF_TOKEN=file-canonical-value\n", { mode: 0o600 });
    const hf = listPanelSecretsMasked().find((s) => s.id === "huggingface")!;
    expect(hf.masked).toBe(maskSecret("shell-canonical-value"));
  });

  it("shows a slot as SET when only its LEGACY alias is configured", () => {
    // Checking the primary alias alone reported "not configured" for a
    // credential that is in effect — the opposite false verdict to #826, and
    // the state a user is most likely to be in after an old install.
    writeFileSync(envPath, "HUGGINGFACE_TOKEN=hf-legacy-value\n", { mode: 0o600 });
    const hf = listPanelSecretsMasked().find((s) => s.id === "huggingface")!;
    expect(hf.set).toBe(true);
    expect(hf.masked).not.toBeNull();
    // The mask is derived from the alias that actually resolves, and shows only
    // the first four and last three characters.
    expect(hf.masked).not.toContain("legacy-val");
  });
});

describe("a blank value is REFUSED, not confirmed (#826 gate round 2)", () => {
  it("refuses a whitespace-only value that would write and read back cleanly", () => {
    // It would persist perfectly and be reported as verified, while every reader
    // (freshSecretValue) treats a blank as absent — a confirmed save nothing
    // downstream can use, which is exactly the #826 shape.
    expect(() => setComfyuiSecret("CIVITAI_API_TOKEN", "   ")).toThrow(
      /empty or whitespace only/,
    );
    expect(() => setComfyuiSecret("CIVITAI_API_TOKEN", "")).toThrow(/empty or whitespace only/);
  });

  it("writes nothing when it refuses, leaving the credential unset", () => {
    try {
      setComfyuiSecret("CIVITAI_API_TOKEN", " ");
    } catch {
      /* expected */
    }
    expect(process.env.CIVITAI_API_TOKEN).toBeUndefined();
    expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBeUndefined();
  });

  it("does not clobber an already-working value when it refuses", () => {
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-working");
    expect(() => setComfyuiSecret("CIVITAI_API_TOKEN", "  ")).toThrow();
    expect(process.env.CIVITAI_API_TOKEN).toBe("civ-working");
  });
});

describe("a rolled-back save reports whether a credential SURVIVED (#826 gate round 2)", () => {
  it("reports stillConfigured:false when nothing was configured before", () => {
    const r = withSwallowedWrites(() => setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new"));
    expect(r.persisted).toBe("no");
    expect(r.stillConfigured).toBe(false);
  });

  it("reports stillConfigured:true when a previous working value survived the rollback", () => {
    // "Nothing is configured" would be FALSE here, and would send the user after
    // the wrong problem — the old credential is still the one in use.
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-working");
    const r = withSwallowedWrites(() => setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new"));
    expect(r.persisted).toBe("no");
    expect(r.stillConfigured).toBe(true);
  });
});

describe("secret values must survive the dotenv round trip, or be refused (#826 gate)", () => {
  it("stores a value containing spaces and reads it back identically", () => {
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "a token with spaces");
    expect(r.persisted).toBe("yes");
    expect(process.env.CIVITAI_API_TOKEN).toBe("a token with spaces");
  });

  it("stores awkward but representable values without corrupting them", () => {
    // Each of these is representable in SOME dotenv encoding, so each must be
    // stored, not refused: refusing a storable credential is its own dead end.
    for (const v of [
      "tok#1",
      'tok"quoted',
      "tok\\back\\slash",
      "tok'single",
      `a'b\\c`,
      `mix'and"quotes`,
      " leading-and-trailing ",
      "tok=with=equals",
    ]) {
      const r = setComfyuiSecret("CIVITAI_API_TOKEN", v);
      expect(r.persisted).toBe("yes");
      expect(process.env.CIVITAI_API_TOKEN).toBe(v);
    }
  });

  it("survives the round trip through the FILE, not just through process.env", () => {
    // process.env is assigned from the in-memory value, so only re-reading the
    // file proves the stored form decodes back to what was supplied.
    for (const v of ["tok#1", 'tok"quoted', "tok\\back\\slash", "tok'single"]) {
      setComfyuiSecret("CIVITAI_API_TOKEN", v);
      expect(readFileSync(envPath, "utf-8")).not.toBe("");
      delete process.env.CIVITAI_API_TOKEN;
      expect(buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN).toBe(v);
    }
  });

  it("REFUSES a value containing a NUL, which the file would keep but process.env would truncate", () => {
    // dotenv round-trips a NUL happily, so the read-back would CONFIRM the save
    // — while process.env (and therefore the spawned child) silently gets a
    // shorter, different string. A confirmed save that delivers something else
    // is the worst outcome of all.
    const withNul = `civ-${String.fromCharCode(0)}-abc`;
    expect(() => setComfyuiSecret("CIVITAI_API_TOKEN", withNul)).toThrow(
      /control character/,
    );
    expect(process.env.CIVITAI_API_TOKEN).toBeUndefined();
  });

  it("REFUSES any other control character for the same reason", () => {
    for (const code of [1, 9, 27, 31, 127]) {
      expect(() =>
        setComfyuiSecret("CIVITAI_API_TOKEN", `civ${String.fromCharCode(code)}abc`),
      ).toThrow(/control character/);
    }
  });

  it("REFUSES a value no encoding can store, rather than writing something different", () => {
    // Storing a mangled copy would be the worst outcome: the save reports
    // success and every request then authenticates with the wrong token.
    // (Found by exhaustive search over dotenv 16.6.1: no encoding of this
    // combination of a single quote, a double quote and a `#` round-trips.)
    const unstorable = `a'"#`;
    expect(() => setComfyuiSecret("CIVITAI_API_TOKEN", unstorable)).toThrow(
      /cannot be stored faithfully/,
    );
    // ...and it says how to proceed from here.
    expect(() => setComfyuiSecret("CIVITAI_API_TOKEN", unstorable)).toThrow(
      /real environment variable/,
    );
  });

  it("never includes the value in the refusal", () => {
    try {
      setComfyuiSecret("CIVITAI_API_TOKEN", `sentinelvalue'"#`);
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as Error).message).not.toContain("sentinelvalue");
      expect((err as Error).message).toContain("cannot be stored faithfully");
    }
  });

  it("either stores a value FAITHFULLY or refuses it — never stores a different value", () => {
    // The invariant behind the whole encoder. Storing something the reader will
    // resolve differently is the silent version of #826: the save reports
    // success and every request then authenticates with the wrong token.
    const nasty = [
      "plain",
      "tok#1",
      'tok"quoted',
      "tok'single",
      "tok\\back\\slash",
      " padded ",
      "with=equals",
      "with\nnewline",
      "with\rcr",
      `civ-${String.fromCharCode(0)}-abc`,
      "back\\slash\"and'quote",
      `a'"#`,
      `a'"#`,
      `'`,
      `"`,
      `\\`,
    ];
    for (const v of nasty) {
      let stored: string | undefined;
      try {
        expect(setComfyuiSecret("CIVITAI_API_TOKEN", v).persisted).toBe("yes");
        delete process.env.CIVITAI_API_TOKEN;
        stored = buildComfyuiMcpEnv({}).CIVITAI_API_TOKEN;
      } catch (err) {
        expect((err as Error).message).toMatch(
          /cannot be stored faithfully|control character/,
        );
        continue;
      }
      expect(stored).toBe(v);
    }
  });

  it("collapses DUPLICATE lines for the key, so no stale line can outrank the save", () => {
    // dotenv lets a later assignment win. Replacing only the first occurrence
    // would leave a stale line authoritative and the save unusable.
    writeFileSync(envPath, "CIVITAI_API_TOKEN=old-a\n# note\nCIVITAI_API_TOKEN=old-b\n", {
      mode: 0o600,
    });
    const r = setComfyuiSecret("CIVITAI_API_TOKEN", "civ-new");
    expect(r.persisted).toBe("yes");
    const raw = readFileSync(envPath, "utf-8");
    expect(raw.match(/^CIVITAI_API_TOKEN=/gm)).toHaveLength(1);
    expect(raw).toContain("# note"); // unrelated lines preserved
    expect(raw).not.toContain("old-b");
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

  it("injects the CURRENT file value, not the copy this process happens to hold", () => {
    // Another valid writer rotated the file after we cached the value. Injecting
    // the stale copy would hand the child a credential the store no longer
    // carries — configured on disk, invisible to the tools all over again.
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-old");
    writeFileSync(envPath, "CIVITAI_API_TOKEN=civ-rotated-elsewhere\n", { mode: 0o600 });
    const env = buildComfyuiMcpEnv({ COMFYUI_URL: "http://x" });
    expect(env.CIVITAI_API_TOKEN).toBe("civ-rotated-elsewhere");
  });

  it("still marks a file-owned key when the store cannot be read at spawn time", () => {
    // The marker must follow PROVENANCE, not a comparison against the file: if
    // the file cannot be read right now there is nothing to compare against, and
    // dropping the marker would pin the injected copy in the child forever —
    // once the file is readable again, a rotate or revoke would never reach it.
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ-owned");
    fsState.readsBroken = true;
    try {
      const env = buildComfyuiMcpEnv({ COMFYUI_URL: "http://x" });
      expect(env.CIVITAI_API_TOKEN).toBe("civ-owned"); // the boot copy still reaches the child
      expect(env[MANAGED_SECRET_KEYS_ENV]?.split(",")).toContain("CIVITAI_API_TOKEN");
    } finally {
      fsState.readsBroken = false;
    }
  });
});
