// #1397 — the ComfyUI-Manager error body was captured and never shown.
//
// panel_update_node failed with "an opaque serialized ComfyUI-Manager
// QueueTaskItem/OperationType exception and no actionable traceback". The body was
// never missing — managerFetch stores it in `details` as { url, status, body } — it
// just never reached the message for any status but 403. The reader got
// `ComfyUI-Manager API 500 Internal Server Error for /v2/manager/queue/task` while
// the exception naming the real cause (a missing Python dependency, in the report)
// sat one layer down.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MANAGER_BODY_EXCERPT_LIMIT,
  managerBodyClause,
  managerBodyExcerpt,
} from "../../services/manager-error-body.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("#1397 the body reaches the message", () => {
  it("carries a serialized Manager exception through", () => {
    // The reported shape.
    const body =
      '{"error":"QueueTaskItem","detail":"OperationType.UPDATE failed: ' +
      "ModuleNotFoundError: No module named 'openai_whisper'\"}";
    const clause = managerBodyClause(body);
    expect(clause).toMatch(/ComfyUI-Manager said:/);
    expect(clause).toMatch(/QueueTaskItem/);
    // The part that actually names the cause must survive.
    expect(clause).toMatch(/No module named 'openai_whisper'/);
  });

  it("accepts an already-parsed body, not only a string", () => {
    // managerFetch parses JSON on the success path; a caller decorating a non-2xx
    // error may hold either shape, and a body that reads as "" because it was an
    // object would reintroduce the defect for exactly the responses that carry most.
    const clause = managerBodyClause({ error: "QueueTaskItem", detail: "boom" });
    expect(clause).toMatch(/QueueTaskItem/);
    expect(clause).toMatch(/boom/);
  });

  it("is empty for an empty or unreadable body, with no dangling separator", () => {
    // The caller appends unconditionally. An unreadable body must cost detail in the
    // text and never produce "ComfyUI-Manager said:" followed by nothing.
    for (const empty of ["", "   ", "\n\t ", undefined, null]) {
      expect(managerBodyClause(empty), JSON.stringify(empty)).toBe("");
    }
  });

  it("never throws while decorating an error", () => {
    // This runs on a path that is already reporting a failure. An error-path guard
    // that becomes the error is strictly worse than the message it was improving.
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => managerBodyClause(circular)).not.toThrow();
    expect(managerBodyClause(circular)).toBe("");
  });
});

describe("#1397 it is BOUNDED, and says when it truncated", () => {
  it("caps a large traceback", () => {
    // #664 is the precedent: a verbatim error payload once carried tensor-sized
    // fields and 41k-token tracebacks into a reply. Unbounded here would trade an
    // unreadable message for an unusable one.
    const huge = "Traceback (most recent call last): " + "x".repeat(50_000);
    const excerpt = managerBodyExcerpt(huge);
    expect(excerpt.length).toBeLessThan(MANAGER_BODY_EXCERPT_LIMIT + 40);
    // The HEAD is kept — a Python exception names its cause at the top.
    expect(excerpt).toMatch(/^Traceback \(most recent call last\):/);
  });

  it("MARKS the truncation rather than cutting silently", () => {
    // A silently cut traceback reads as a complete one, and the reader concludes the
    // exception ended where the budget did.
    expect(managerBodyExcerpt("y".repeat(5_000))).toMatch(/… \[truncated\]$/);
    // And a body that fits is NOT marked.
    expect(managerBodyExcerpt("short and complete")).toBe("short and complete");
    expect(managerBodyExcerpt("short and complete")).not.toMatch(/truncated/);
  });

  it("collapses whitespace so a traceback stays one readable line", () => {
    expect(managerBodyExcerpt("line one\n\n   line two\t\tline three")).toBe(
      "line one line two line three",
    );
  });
});

describe("#1397 WIRING: the non-2xx site actually appends it", () => {
  const src = readFileSync(join(HERE, "../../services/node-management.ts"), "utf8");

  it("managerFetch's failure message carries the clause", () => {
    // The behavioural tests cannot see the call site, and the defect WAS the call
    // site: the helper is useless if the thrower still reports a bare status line.
    expect(src).toMatch(/import \{ managerBodyClause \} from "\.\/manager-error-body\.js";/);
    const at = src.indexOf("`ComfyUI-Manager API ${res.status} ${res.statusText} for ${path}`");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 700)).toMatch(/managerBodyClause\(text\)/);
  });

  it("the 403 explanation is kept, not replaced", () => {
    // explainManagerForbidden says something this excerpt cannot — that a 403 is
    // Manager's security setting rather than a broken request. Losing it would trade
    // one specific message for a generic one.
    const at = src.indexOf("`ComfyUI-Manager API ${res.status} ${res.statusText} for ${path}`");
    expect(src.slice(at, at + 700)).toMatch(/explainManagerForbidden\(res\.status, text\)/);
  });

  it("the body is still captured in details", () => {
    // The excerpt is bounded, so `details.body` remains the complete record for
    // anything that needs it. Dropping it would lose data to gain readability.
    const at = src.indexOf("`ComfyUI-Manager API ${res.status} ${res.statusText} for ${path}`");
    expect(src.slice(at, at + 700)).toMatch(/\{ url, status: res\.status, body: text \}/);
  });
});

describe("#1397 a credential never reaches the message", () => {
  // The excerpt is an ARBITRARY upstream payload on a user-visible path, and a
  // Manager failure is exactly where a credential shows up: a pack install that
  // cannot clone echoes the git remote. The rule here is that a secret never appears
  // in an error, so these are the shapes, not a list of key names — the next
  // credential will not be on a list.

  it("strips credentials from a git remote in a clone failure", () => {
    const body =
      "CalledProcessError: git clone https://octocat:ghp_ABCDEFG1234567890abcdef@github.com/o/r.git failed";
    const out = managerBodyExcerpt(body);
    expect(out).not.toMatch(/ghp_ABCDEFG1234567890abcdef/);
    expect(out).not.toMatch(/octocat:/);
    expect(out).toMatch(/\*\*\*:\*\*\*@github\.com/);
    // The DIAGNOSIS survives the redaction — that is the whole point of the excerpt.
    expect(out).toMatch(/CalledProcessError/);
    expect(out).toMatch(/github\.com\/o\/r\.git/);
  });

  it("strips bearer/token headers echoed into a traceback", () => {
    const out = managerBodyExcerpt('headers={"Authorization": "Bearer sk-live-ABCDEF1234567890"}');
    expect(out).not.toMatch(/sk-live-ABCDEF1234567890/);
    expect(out).toMatch(/Bearer \*\*\*/i);
  });

  it("strips token-ish query params and reprs", () => {
    for (const body of [
      "GET /manager/queue/task?api_key=ABCDEF1234567890 failed",
      "config: {'civitai_token': 'ABCDEF1234567890'}",
      'url=https://x/y?access_token=ABCDEF1234567890',
    ]) {
      const out = managerBodyExcerpt(body);
      expect(out, body).not.toMatch(/ABCDEF1234567890/);
      expect(out, body).toMatch(/\*\*\*/);
    }
  });

  it("redacts BEFORE the cap, so truncation cannot preserve half a secret", () => {
    // Order is load-bearing. Redacting after the slice would leave the first half of
    // a credential that straddles the boundary — a partial secret is a leaked one.
    // Written as ONE literal, not assembled from fragments: check:vocabulary refuses a
    // string built at runtime because a tool name spelled that way is invisible to it
    // and survives every rename. A fake credential trips the same rule, and the rule is
    // right — the fix is to stop concatenating, not to loosen the gate.
    const secret =
      "ghp_ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ";
    const filler =
      "filler filler filler filler filler filler filler filler filler filler filler " +
      "filler filler filler filler filler filler filler filler filler filler filler ";
    const body = `${filler}https://u:${secret}@h/r.git`;
    const out = managerBodyExcerpt(body, 700);
    expect(out).not.toMatch(/ghp_ZZZ/);
  });

  it("redacts an Authorization: Basic header - both halves of a credential at once", () => {
    // Found by review: `basic` was the one scheme the alternation missed. It matters
    // MORE than the others, not less - the base64 blob decodes to `user:password`, so
    // leaking it leaks the account itself, not a token that can be rotated.
    const secret = "QWxhZGRpbjpvcGVuc2VzYW1l";
    const out = managerBodyExcerpt(
      "HTTPError: 401 Client Error for url http://127.0.0.1:8188/api/manager/queue/install " +
        "(sent Authorization: Basic " + secret + ")",
    );
    expect(out).not.toContain(secret);
    expect(out).toMatch(/Basic \*\*\*/);
    // The diagnosis still survives - redaction must not cost the reason.
    expect(out).toMatch(/401/);
  });

  it("truncation never ends on half a surrogate pair", () => {
    // `limit` counts UTF-16 code units, so a cut can land BETWEEN the halves of an
    // emoji. The orphan serialises to U+FFFD, and a body that was merely long then
    // reads as corrupted - "the tool mangled it" rather than "it was truncated".
    //
    // Cut lands exactly mid-pair: (limit - 1) filler chars, then a 2-unit emoji.
    const body = "a".repeat(MANAGER_BODY_EXCERPT_LIMIT - 1) + "\u{1F600}tail";
    const out = managerBodyExcerpt(body);
    expect(out).toMatch(/\[truncated\]$/);
    expect(out).not.toContain("\uFFFD");
    // No lone surrogate survives: iterating by code point, any leading surrogate must
    // come paired (a whole pair iterates as a single 2-unit string).
    for (const ch of out) {
      const c = ch.charCodeAt(0);
      if (c >= 0xd800 && c <= 0xdbff) expect(ch.length).toBe(2);
    }
  });

  it("does not over-redact an ordinary exception", () => {
    // Over-redaction makes the excerpt useless, and this exists to make an opaque
    // failure readable. A normal traceback must come through intact.
    const body = "ModuleNotFoundError: No module named 'openai_whisper' in /home/u/ComfyUI/custom_nodes/x";
    expect(managerBodyExcerpt(body)).toBe(body);
  });
});
