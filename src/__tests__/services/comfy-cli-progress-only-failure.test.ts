// #417 — a progress line is not a failure reason.
//
// The reporter's download died and the error they were handed was
// `Start downloading URL ... into ...`: comfy-cli's own pre-download announcement,
// promoted into the message field because it was the only thing on stderr. It reads like
// a diagnosis, names no cause, and cost them a debugging session on a URL and a directory
// that were both fine.
//
// The half of this issue about the 60s kill shipped in v0.48.12 (idle/liveness timeout).
// This is the other half: distinguishing "the reason is X" from "there is no reason in
// the output", instead of dressing the second up as the first (#796).
//
// THE TEST THAT MATTERS IS THE NEGATIVE ONE. A filter that strips too much replaces a real
// error message with "no reason available" — strictly worse than the bug, and invisible,
// because both the buggy and the over-eager version produce a confident-looking envelope.
// So most of what follows checks that real messages SURVIVE.

import { describe, expect, it } from "vitest";

import { failureReasonFrom, normalizeComfyCliResult } from "../../services/comfy-cli.js";

const OPTS = { where: "local" as const };
const ARGS = ["model", "download", "--url", "https://example.invalid/m.safetensors"];

function failedWith(stderr: string, stdout = "") {
  return normalizeComfyCliResult(ARGS, OPTS, { stdout, stderr, exitCode: 1 }, "1.12.0");
}

describe("failureReasonFrom keeps anything it does not RECOGNISE as progress (#417)", () => {
  it("the reporter's exact line carries no reason", () => {
    expect(
      failureReasonFrom(
        "Start downloading URL https://huggingface.co/x/y.safetensors into E:\\ComfyUI_windows_portable\\ComfyUI\\models\\text_encoders\\y.safetensors",
      ),
    ).toBeNull();
  });

  it("tqdm progress, drawn or not, carries no reason", () => {
    expect(failureReasonFrom(" 45%|█████     | 1.2G/2.7G [00:30<00:40, 40.0MB/s]")).toBeNull();
    expect(failureReasonFrom(" 45%|          | 1.2G/2.7G")).toBeNull();
    expect(failureReasonFrom("Downloading: 45%")).toBeNull();
    expect(failureReasonFrom("[####------] ")).toBeNull();
    expect(failureReasonFrom("   \n\n  ")).toBeNull();
  });

  it("a REAL error survives, including ones that mention downloading or a percentage", () => {
    // The over-strip direction. Every string here would be eaten by the obvious
    // implementation — a keyword test on "download", or "contains %".
    const real = [
      "HTTP 403 while downloading https://huggingface.co/gated/model.safetensors",
      "OSError: [Errno 28] No space left on device",
      "requests.exceptions.ConnectionError: Max retries exceeded",
      "Error: downloading failed after 3 attempts",
      "Download aborted at 45% — checksum mismatch",
      "RepositoryNotFoundError: 401 Client Error",
    ];
    for (const line of real) {
      expect(failureReasonFrom(line), line).toBe(line);
    }
  });

  it("a real error mixed INTO progress output is extracted, not lost", () => {
    // The common real-world shape: progress, then the thing that actually went wrong.
    const captured = [
      "Start downloading URL https://example.invalid/m.safetensors into C:\\models\\m.safetensors",
      " 12%|█         | 300M/2.5G [00:10<01:20, 30.0MB/s]",
      "OSError: [Errno 28] No space left on device",
    ].join("\n");
    expect(failureReasonFrom(captured)).toBe("OSError: [Errno 28] No space left on device");
  });

  it("splits on carriage returns, so a bar that ENDS in an error still yields the error", () => {
    // A progress bar redraws with \r. Split only on \n and the bar plus its trailing error
    // are one line, which matches no progress pattern — so the whole bar would be handed
    // back as the "reason", burying the one useful sentence in redraw noise.
    const bar = " 10%|# |\r 20%|## |\r 30%|### |\rConnectionResetError: peer closed";
    expect(failureReasonFrom(bar)).toBe("ConnectionResetError: peer closed");
  });
});

describe("the envelope says which of the three states it is in (#417)", () => {
  it("progress-only output is reported as NO reason available, and says what to check", () => {
    const env = failedWith(
      "Start downloading URL https://huggingface.co/x/y.safetensors into E:\\ComfyUI\\models\\text_encoders\\y.safetensors",
    );
    expect(env.ok).toBe(false);
    expect(env.error?.code).toBe("legacy_command_failed");
    // The message must NOT be the progress line dressed as a cause.
    expect(env.error?.message).not.toMatch(/Start downloading URL/);
    expect(env.error?.message).toMatch(/printed no error/);
    expect(env.error?.message).toMatch(/exited with code 1/);
    expect(env.error?.hint).toMatch(/disk space/i);
    expect(env.error?.hint).toMatch(/auth|401|403/i);
    // …and the raw output is still there. Judging it uninformative is not licence to
    // drop it — the next reporter may recognise something in it that we do not.
    expect(env.error?.details).toMatchObject({ exit_code: 1 });
    expect(JSON.stringify(env.error?.details)).toMatch(/Start downloading URL/);
  });

  it("a real stderr is passed through UNCHANGED, with no hint bolted on", () => {
    const env = failedWith("OSError: [Errno 28] No space left on device");
    expect(env.error?.message).toBe("OSError: [Errno 28] No space left on device");
    // A hint here would be noise at best and misdirection at worst — the message already
    // says exactly what happened.
    expect(env.error?.hint).toBeUndefined();
  });

  it("falls back to stdout when stderr is progress-only but stdout has the reason", () => {
    const env = failedWith(" 45%|#####     | 1.2G/2.7G", "fatal: destination path is not writable");
    expect(env.error?.message).toBe("fatal: destination path is not writable");
    expect(env.error?.hint).toBeUndefined();
  });

  it("an empty capture is still the no-reason case, not an empty message", () => {
    const env = failedWith("", "");
    expect(env.error?.message).toMatch(/exited with code 1/);
    expect(env.error?.message).not.toBe("");
  });

  it("a SUCCESSFUL command is untouched — this only ever runs on a non-zero exit", () => {
    const env = normalizeComfyCliResult(
      ARGS,
      OPTS,
      { stdout: "Start downloading URL https://x/y into /z", stderr: "", exitCode: 0 },
      "1.12.0",
    );
    expect(env.ok).toBe(true);
    expect(env.error).toBeNull();
  });
});
