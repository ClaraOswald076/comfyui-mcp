// #826 — a credential saved AFTER a process started must become visible to it.
//
// The comfyui MCP child snapshotted its download tokens from process.env at
// module load, and the canonical ~/.comfyui-mcp/.env was read exactly once at
// boot. panel_request_secret writes that file and then relies on the orchestrator
// RESPAWNING the child to inject the value; when the respawn did not fire the
// token was invisible for the life of the process while every download kept
// returning 401. These tests pin the access-time resolution that removes the
// dependency — including the two directions that are easy to get backwards:
// a stale BOOT-SEEDED value must not outrank a fresh file read, and a REVOKE
// (key removed from the file) must not be papered over by that same stale value.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  comfyuiEnvFilePath,
  freshSecretValue,
  loadEnvFileIntoProcess,
  markFileDerived,
  parseEnvFile,
  resetEnvFileProvenanceForTests,
  secretKeyPresent,
  MANAGED_SECRET_KEYS_ENV,
} from "../env-file.js";

const KEYS = ["CIVITAI_API_TOKEN", "HF_TOKEN", "HUGGINGFACE_TOKEN", MANAGED_SECRET_KEYS_ENV];

let dir: string;
let envPath: string;
let saved: Record<string, string | undefined>;

function writeEnv(lines: string): void {
  writeFileSync(envPath, lines, { mode: 0o600 });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-envfile-"));
  envPath = join(dir, ".env");
  process.env.COMFYUI_MCP_ENV_FILE = envPath;
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  resetEnvFileProvenanceForTests();
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_ENV_FILE;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetEnvFileProvenanceForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("env-file: which file is 'the' credential file", () => {
  it("honors COMFYUI_MCP_ENV_FILE so the writer and every reader resolve the same path", () => {
    expect(comfyuiEnvFilePath()).toBe(envPath);
  });

  it("distinguishes UNREADABLE (null) from ABSENT-or-EMPTY ({}) — a revoke must not read as unknown", () => {
    // This test used to assert the opposite for the absent case, and that was the
    // bug (codex gate P0). The distinction that matters is "I could not read the
    // file" versus "the file carries no keys" — and an absent file is the SECOND
    // of those: it is a successful observation, not a failed one. Returning the
    // unknown answer for it made `freshSecretValue` skip its revoke branch and
    // fall back to the copy seeded at boot, so a long-lived child kept using a
    // token whose file had disappeared.
    expect(parseEnvFile()).toEqual({}); // absent — carries no keys, and we know it
    writeEnv("");
    expect(parseEnvFile()).toEqual({}); // present but empty — the same statement
  });

  it("a file that VANISHES after boot revokes the value it seeded, rather than resurrecting it", () => {
    // The sequence the gate walked: boot from the file, then the file disappears
    // (an accidental delete, an interrupted replacement). The value is
    // file-derived, so nothing else vouches for it — and continuing to serve it
    // means a child can re-inject a credential the file no longer holds.
    writeEnv("CIVITAI_API_TOKEN=civ-seeded");
    expect(loadEnvFileIntoProcess()).toEqual(["CIVITAI_API_TOKEN"]);
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("civ-seeded");

    rmSync(envPath, { force: true });

    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBeUndefined();
    expect(secretKeyPresent("CIVITAI_API_TOKEN")).toBe(false);
  });

  it("an UNREADABLE file keeps the seeded value — inconclusive is not a revoke", () => {
    // The inverse direction, and the reason this is not simply "absent means
    // gone": a file we could not read says nothing about the credential, and
    // dropping a working token on a transient EACCES would be a false revoke.
    writeEnv("CIVITAI_API_TOKEN=civ-seeded");
    expect(loadEnvFileIntoProcess()).toEqual(["CIVITAI_API_TOKEN"]);

    // A directory where the file should be: present, and unreadable as a file.
    rmSync(envPath, { force: true });
    mkdirSync(envPath, { recursive: true });
    try {
      expect(parseEnvFile()).toBeNull();
      expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("civ-seeded");
    } finally {
      rmSync(envPath, { recursive: true, force: true });
    }
  });
});

describe("env-file: freshSecretValue resolves at ACCESS time (#826)", () => {
  it("sees a token written to the file AFTER boot, with no respawn", () => {
    // Boot with no token at all — this is the child at spawn time.
    expect(loadEnvFileIntoProcess()).toEqual([]);
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBeUndefined();

    // The panel saves a token later. The process is NOT restarted.
    writeEnv("CIVITAI_API_TOKEN=civ-late\n");

    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("civ-late");
    expect(secretKeyPresent("CIVITAI_API_TOKEN")).toBe(true);
  });

  it("lets a FRESH file read supersede the value the same file seeded at boot", () => {
    // This is the inversion that kept #826 alive: dotenv copies the file value
    // into process.env at boot, so "real env vars win" silently pinned the STALE
    // boot value forever once the file changed.
    writeEnv("CIVITAI_API_TOKEN=old-value\n");
    expect(loadEnvFileIntoProcess()).toEqual(["CIVITAI_API_TOKEN"]);
    expect(process.env.CIVITAI_API_TOKEN).toBe("old-value");

    writeEnv("CIVITAI_API_TOKEN=rotated\n");

    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("rotated");
  });

  it("keeps a REAL environment variable winning over the file (the shell escape hatch)", () => {
    process.env.CIVITAI_API_TOKEN = "from-shell";
    writeEnv("CIVITAI_API_TOKEN=from-file\n");
    // Boot must not clobber an env var that was already set...
    expect(loadEnvFileIntoProcess()).toEqual([]);
    // ...and it must keep outranking the file afterward.
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("from-shell");
  });

  it("treats a key REMOVED from a readable file as gone, not as the stale boot value", () => {
    writeEnv("CIVITAI_API_TOKEN=to-be-revoked\n");
    loadEnvFileIntoProcess();
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("to-be-revoked");

    writeEnv("# revoked\n"); // the panel cleared the slot

    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBeUndefined();
    expect(secretKeyPresent("CIVITAI_API_TOKEN")).toBe(false);
  });

  it("falls back to the boot-seeded value when the file becomes UNREADABLE — unknown is not 'revoked'", () => {
    writeEnv("CIVITAI_API_TOKEN=still-valid\n");
    loadEnvFileIntoProcess();
    // Simulate an unreadable file by pointing at a directory: parseEnvFile()
    // returns null (couldn't determine), which must NOT be read as "removed".
    process.env.COMFYUI_MCP_ENV_FILE = dir;
    expect(parseEnvFile()).toBeNull();
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("still-valid");
  });

  it("honors alias order — HF_TOKEN before HUGGINGFACE_TOKEN", () => {
    writeEnv("HUGGINGFACE_TOKEN=legacy\nHF_TOKEN=canonical\n");
    expect(freshSecretValue("HF_TOKEN", "HUGGINGFACE_TOKEN")).toBe("canonical");
    writeEnv("HUGGINGFACE_TOKEN=legacy\n");
    expect(freshSecretValue("HF_TOKEN", "HUGGINGFACE_TOKEN")).toBe("legacy");
  });

  it("lets the CANONICAL alias in the file beat a legacy alias set in the shell", () => {
    // Checking every alias's env value before any alias's file value made a
    // pre-existing shell HUGGINGFACE_TOKEN outrank a freshly saved HF_TOKEN, so
    // the save reported success and every download kept using the old
    // credential — #826 all over again. Each alias resolves FULLY in turn.
    process.env.HUGGINGFACE_TOKEN = "legacy-from-shell";
    writeEnv("HF_TOKEN=canonical-just-saved\n");
    expect(freshSecretValue("HF_TOKEN", "HUGGINGFACE_TOKEN")).toBe("canonical-just-saved");
  });

  it("keeps the shell escape hatch WITHIN one alias", () => {
    process.env.HF_TOKEN = "canonical-from-shell";
    writeEnv("HF_TOKEN=canonical-from-file\n");
    expect(freshSecretValue("HF_TOKEN", "HUGGINGFACE_TOKEN")).toBe("canonical-from-shell");
  });

  it("falls through to the legacy alias only when the canonical one is unset everywhere", () => {
    process.env.HUGGINGFACE_TOKEN = "legacy-from-shell";
    writeEnv("# no HF_TOKEN here\n");
    expect(freshSecretValue("HF_TOKEN", "HUGGINGFACE_TOKEN")).toBe("legacy-from-shell");
  });

  it("ignores a blank value (a key present but empty is not a credential)", () => {
    writeEnv("CIVITAI_API_TOKEN=\n");
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBeUndefined();
  });

  it("lets the file supersede a credential INHERITED from the parent when it is marked managed", () => {
    // The orchestrator injects current credential values into the child's spawn
    // env, so the child sees them as real environment variables and would pin
    // them for its whole life — a rotate or revoke ignored forever, while the
    // save reports that the running tools re-read the file. The marker (KEY
    // NAMES only) tells the child the file is their authority.
    process.env.CIVITAI_API_TOKEN = "inherited-at-spawn";
    process.env[MANAGED_SECRET_KEYS_ENV] = "CIVITAI_API_TOKEN";
    writeEnv("CIVITAI_API_TOKEN=inherited-at-spawn\n");
    loadEnvFileIntoProcess();
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("inherited-at-spawn");

    writeEnv("CIVITAI_API_TOKEN=rotated-later\n");
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("rotated-later");

    writeEnv("# revoked\n");
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBeUndefined();
  });

  it("keeps pinning an inherited credential that was NOT marked managed", () => {
    // An unmarked inherited value came from a real environment variable (the
    // shell escape hatch); an unrelated file entry must not override it.
    process.env.HF_TOKEN = "inherited-from-shell";
    writeEnv("HF_TOKEN=file-value\n");
    loadEnvFileIntoProcess();
    expect(freshSecretValue("HF_TOKEN")).toBe("inherited-from-shell");
  });

  it("markFileDerived makes the file authoritative for a key assigned in-process", () => {
    process.env.CIVITAI_API_TOKEN = "just-assigned";
    writeEnv("CIVITAI_API_TOKEN=just-assigned\n");
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("just-assigned");
    markFileDerived("CIVITAI_API_TOKEN");
    writeEnv("CIVITAI_API_TOKEN=rotated-by-another-process\n");
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("rotated-by-another-process");
  });

  it("ignores a blank/whitespace marker list without marking a phantom key", () => {
    process.env[MANAGED_SECRET_KEYS_ENV] = " , ,";
    process.env.CIVITAI_API_TOKEN = "from-shell";
    writeEnv("CIVITAI_API_TOKEN=from-file\n");
    loadEnvFileIntoProcess();
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBe("from-shell");
  });

  it("never throws on a corrupt file — an unparseable store means 'no credential', not a crash", () => {
    writeFileSync(envPath, "= no key here\n[not a dotenv section]\n\"unterminated", { mode: 0o600 });
    chmodSync(envPath, 0o600);
    expect(() => freshSecretValue("CIVITAI_API_TOKEN")).not.toThrow();
    expect(freshSecretValue("CIVITAI_API_TOKEN")).toBeUndefined();
  });
});
