// #1326 — an install-model failure on legacy Manager asserted one cause for every
// failure, and threw away the evidence that would have decided it.
//
// The reporter dispatched three Hugging Face URLs to a ComfyUI running Manager 3.x and
// got, three times:
//
//   MODEL_ERROR: ComfyUI-Manager API 500 Internal Server Error for
//   /manager/queue/install_model. Arbitrary-URL model installs REQUIRE Manager v4+
//   (3.x only accepts whitelisted catalog models).
//
// The second sentence was appended unconditionally — `kind === "install-model"` was the
// whole test. It is the likeliest cause and it was probably right here, but the same
// line is produced by a security_level refusal, a 404 URL, and a full disk, and it sends
// the reader through a Manager migration that would not fix any of those.
//
// Meanwhile Manager's own response body was captured in `details.body` and never shown:
// explainManagerForbidden only speaks for 403, so a 500 reached the user as a bare
// status. Same defect as #1300 (a download that reported a status instead of a reason).
//
// WHY NOT A BLANKET PREFLIGHT, which the report suggested. Manager 3.x does accept an
// install whose URL is in its model-list catalog — `legacyTaskRequest` sends the same
// body and 3.x validates it. Refusing every install-model on 3.x would therefore break
// the whitelisted case that works today, which is the over-broad direction of a blocking
// guard: invisible in its own output, and it un-ships a working feature.

import { describe, expect, it } from "vitest";

import { __managerCauseTestHooks } from "../../services/node-management.js";

const { annotateLegacyError, NodeManagementError } = __managerCauseTestHooks;

/** The shape managerFetch throws on a non-2xx: status and body ARE captured. */
function managerHttpError(status: number, body: string, url = "http://pod:8188/manager/queue/install_model") {
  return new NodeManagementError(`ComfyUI-Manager API ${status} Internal Server Error for /manager/queue/install_model`, {
    url,
    status,
    body,
  });
}

describe("an install-model failure only claims a cause it can support (#1326)", () => {
  it("PROVEN whitelist rejection: still says exactly what it always said", () => {
    // The common case must not regress — when Manager names the model list, the
    // definite answer and its migration path are correct and stay.
    const msg = annotateLegacyError(
      managerHttpError(500, '{"error": "not found in the model list"}'),
      "install-model",
    ).message;

    expect(msg).toContain("REQUIRE Manager v4+");
    expect(msg).toContain("pip install -U comfyui_manager"); // the migration hint
    expect(msg).not.toContain("did NOT say why");
  });

  it("UNDETERMINED cause: keeps the likely diagnosis, drops only the certainty", () => {
    // The reporter's actual response: a 500 with nothing in it.
    //
    // My first version of this hedged the whole thing away — "this did NOT say why …
    // do not migrate Manager on the strength of this line alone". The pre-existing #553
    // test caught it, correctly: on 3.x the whitelist IS the usual cause and that
    // migration IS the fix, so burying it under a disclaimer trades a probably-right
    // answer for a definitely-useless one. Precision is not the defect; false certainty
    // and the discarded evidence are.
    const msg = annotateLegacyError(managerHttpError(500, ""), "install-model").message;

    // The actionable diagnosis survives, in full.
    expect(msg).toMatch(/REQUIRE Manager v4\+/);
    expect(msg).toMatch(/usual cause is its model-list whitelist/);
    expect(msg).toContain("pip install -U comfyui_manager");
    // …now stated as likely rather than established, with the alternatives it hid.
    expect(msg).toMatch(/did NOT say so explicitly/);
    expect(msg).toMatch(/security_level/);
    expect(msg).toMatch(/unreachable URL|no space/);
  });

  it("a 403 is a security refusal — the whitelist is EXCLUDED, not offered", () => {
    // Adding "you need Manager v4+" beside the security_level explanation would give
    // two causes for one failure, one of them wrong, and the wrong one is the expensive
    // one to act on.
    const msg = annotateLegacyError(
      managerHttpError(403, '{"error": "security_level"}'),
      "install-model",
    ).message;

    expect(msg).not.toContain("REQUIRE Manager v4+");
    expect(msg).not.toContain("did NOT say why");
  });

  it("shows Manager's OWN words — the evidence that was being discarded", () => {
    const msg = annotateLegacyError(
      managerHttpError(500, '{"error": "No space left on device"}'),
      "install-model",
    ).message;

    expect(msg).toContain("ComfyUI-Manager said:");
    expect(msg).toContain("No space left on device");
  });

  it("never echoes a credential from the request URL into the message", () => {
    // A model URL routinely carries a token in its query. The body can echo the URL
    // back, and an error message is the one place a secret must never surface.
    const secret = "hf_SUPERSECRETTOKENVALUE123";
    const url = `http://pod:8188/manager/queue/install_model?token=${secret}`;
    const msg = annotateLegacyError(
      managerHttpError(500, `failed fetching https://host/x.safetensors?token=${secret}`, url),
      "install-model",
    ).message;

    expect(msg).not.toContain(secret);
    expect(msg).toContain("«redacted»");
  });

  it("bounds the excerpt so a huge HTML error page cannot flood the reply", () => {
    const msg = annotateLegacyError(managerHttpError(500, "x".repeat(5000)), "install-model").message;
    expect(msg).toContain("(truncated)");
    expect(msg.length).toBeLessThan(2500);
  });

  it("a NON-install failure is untouched — the scope did not widen", () => {
    // Only install-model ever carried this sentence; nothing else should gain it.
    const msg = annotateLegacyError(managerHttpError(500, "boom"), "install").message;
    expect(msg).not.toContain("REQUIRE Manager v4+");
    expect(msg).not.toContain("did NOT say why");
    expect(msg).not.toContain("ComfyUI-Manager said:");
  });

  it("survives an error carrying no details at all", () => {
    const msg = annotateLegacyError(new Error("socket hang up"), "install-model").message;
    expect(msg).toContain("socket hang up");
    expect(msg).toContain("did NOT say so explicitly"); // undetermined, and says so
    expect(msg).not.toContain("ComfyUI-Manager said:");
  });
});
