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
  describeRunError,
  looksLikeAuthFailure,
  promptIdOf,
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

// #889 — the run-error notification opened "The workflow run YOU JUST QUEUED
// ERRORED" as a fixed template, and was delivered to a session whose agent had
// never called panel_run at all. It burned a panel_get_errors round trip on a
// failure it did not cause and got back errored_count: 0.
//
// The wording is what made that expensive rather than cosmetic: told to STOP and
// to relate the error to its work, an agent will find a relation.
describe("#889: a run error does not assert who queued it", () => {
  const ERR = "Render status for prompt 9d70fd9d-1c2b-4e3f-8a01-7c6d5e4f3a2b could not be confirmed";

  it("finds the prompt id inside the prose", () => {
    expect(promptIdOf(ERR)).toBe("9d70fd9d-1c2b-4e3f-8a01-7c6d5e4f3a2b");
  });

  it("returns nothing rather than a wrong id when there is none", () => {
    expect(promptIdOf("the canvas errored")).toBeUndefined();
    expect(promptIdOf("")).toBeUndefined();
    // A short hex blob is not a uuid and must not be mistaken for one.
    expect(promptIdOf("prompt 9d70fd9d")).toBeUndefined();
  });

  it("keeps the urgent wording for a run the agent PROVABLY queued", () => {
    const t = describeRunError(ERR, "mine");
    expect(t).toMatch(/run you queued ERRORED/);
    expect(t).toMatch(/STOP/);
    expect(t).toMatch(/panel_get_errors/);
  });

  // THE reported case.
  it("states plainly that the agent did not queue it, and says not to hunt for a link", () => {
    const t = describeRunError(ERR, "not-mine");
    expect(t).not.toMatch(/you (just )?queued/);
    expect(t).toMatch(/You did NOT queue this run/);
    expect(t).toMatch(/do not look for a connection/);
    // The imperative that made the misattribution costly is gone.
    expect(t).not.toMatch(/STOP —/);
  });

  // "Could not determine" must not collapse into either certainty: claiming it
  // is the agent's repeats the bug, claiming it is not risks telling an agent to
  // ignore its own failed render.
  it("declines to decide when it cannot, and covers both readings", () => {
    const t = describeRunError(ERR, "unknown");
    expect(t).toMatch(/could NOT be determined/);
    expect(t).toMatch(/do not assume either way/);
    expect(t).toMatch(/If you were waiting on a render/);
    expect(t).toMatch(/if you were not/i);
    expect(t).not.toMatch(/You did NOT queue this run/);
  });

  it("always carries the underlying error text, whatever the attribution", () => {
    for (const a of ["mine", "not-mine", "unknown"] as const) {
      expect(describeRunError(ERR, a)).toContain(ERR);
    }
  });
});
