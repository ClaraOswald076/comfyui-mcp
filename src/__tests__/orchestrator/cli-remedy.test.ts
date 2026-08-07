// #948 — a correct instruction delivered to the wrong place is a wrong instruction.
//
// A user saw `Not logged in, please run /login` in the PANEL CHAT and reported
// that `/login` "doesn't exist as a command". They were right: it is typed at the
// `pi` CLI's own prompt. In a chat box a leading `/` reads as "type this here",
// so the remedy was accurate and unusable at the same time — and it pointed at
// the one place it could not work.
//
// It is also wrong across providers: a user on the Claude or Codex chip has no
// `/login` at all, so a passed-through string naming it is false, not just
// unhelpful.

import { describe, expect, it } from "vitest";
import {
  looksLikeAuthFailure,
  providerAuthRemedy,
  qualifySlashCommands,
} from "../../orchestrator/cli-remedy.js";

describe("#948: a bare slash command never reaches chat unqualified", () => {
  it("says WHERE the prompt is, not just what to type", () => {
    const out = qualifySlashCommands("Not logged in, please run /login", "pi");
    expect(out).toMatch(/`pi`, then type `\/login` at its prompt/);
    // The bare form — the thing that read as a chat command — is gone.
    expect(out).not.toMatch(/run \/login/);
  });

  it("shortens repeats instead of restating the whole clause", () => {
    const out = qualifySlashCommands("try /login, then /status", "pi");
    expect(out).toMatch(/`pi`, then type `\/login` at its prompt/);
    expect(out).toMatch(/`\/status` \(at the `pi` prompt\)/);
  });

  // Paths, URLs and dates are VALUES, not instructions. Rewriting them would
  // corrupt the very detail that makes an error diagnosable.
  it("leaves paths and URLs alone", () => {
    for (const s of [
      "spawn /usr/bin/pi ENOENT",
      "see https://pi.dev/docs for setup",
      "config at /home/u/.pi/agent/auth.json",
      "C:/Users/x/pi.exe not found",
    ]) {
      expect(qualifySlashCommands(s, "pi")).toBe(s);
    }
  });

  it("is a no-op on text with no slash command", () => {
    expect(qualifySlashCommands("pi exited with code 1", "pi")).toBe("pi exited with code 1");
    expect(qualifySlashCommands("", "pi")).toBe("");
  });
});

describe("#948: the auth remedy names the place, not only the keystrokes", () => {
  it("tells a pi user to go to a terminal, and what that writes", () => {
    const msg = providerAuthRemedy("pi");
    expect(msg).toMatch(/TERMINAL/);
    expect(msg).toMatch(/type `\/login` at its prompt/);
    expect(msg).toMatch(/~\/\.pi\/agent\/auth\.json/);
    expect(msg).toMatch(/Disconnect → Connect/);
  });

  // The cross-provider half: these users have no /login at all, so naming it
  // would be false rather than merely unhelpful.
  it("never mentions /login for a provider that has no such command", () => {
    expect(providerAuthRemedy("codex")).toMatch(/codex login/);
    expect(providerAuthRemedy("codex")).not.toMatch(/\/login/);
    expect(providerAuthRemedy("claude")).toMatch(/claude setup-token/);
    expect(providerAuthRemedy("claude")).not.toMatch(/\/login/);
    expect(providerAuthRemedy("gemini")).not.toMatch(/\/login/);
  });

  it("has a usable answer for a backend it does not know by name", () => {
    const msg = providerAuthRemedy("some-new-provider");
    expect(msg).toContain("some-new-provider");
    expect(msg).toMatch(/API Keys card|TERMINAL/);
    expect(msg).not.toMatch(/\/login/);
  });

  // The CLI's own tail carries the real reason (expired token vs missing file),
  // so it is kept — but it is the exact channel the bare /login came through,
  // so it must be qualified on the way in.
  it("keeps the CLI's detail but strips its bare slash command", () => {
    const msg = providerAuthRemedy("pi", "Not logged in, please run /login");
    expect(msg).toMatch(/Not logged in/);
    expect(msg).not.toMatch(/please run \/login/);
    expect(msg).toMatch(/at its prompt|at the `pi` prompt/);
  });

  it("omits the detail block entirely when there is nothing to say", () => {
    expect(providerAuthRemedy("pi", "   ")).not.toMatch(/\(\s*\)/);
  });
});

describe("#948: recognising the condition", () => {
  it("matches the phrasings CLIs actually use", () => {
    for (const s of [
      "Not logged in, please run /login",
      "you have been logged out",
      "unauthorized",
      "missing API key",
      "no provider credentials configured",
      "please sign in",
      "authentication failed",
    ]) {
      expect(looksLikeAuthFailure(s), s).toBe(true);
    }
  });

  it("does not claim an unrelated failure is about credentials", () => {
    for (const s of ["ENOENT: no such file", "exited with code 137", "connection reset"]) {
      expect(looksLikeAuthFailure(s), s).toBe(false);
    }
  });
});
