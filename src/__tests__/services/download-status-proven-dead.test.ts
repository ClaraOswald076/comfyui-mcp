// #1479 — download_model action:"status" reported PROVEN-dead downloads as
// "still streaming".
//
// Three transfers died with their owning process. Status rendered them as
// **downloading — still streaming** with "the transfer may still be running … Do not
// report this download as failed or missing", while action:"cancel" on the same ids
// answered "that session is confirmed GONE — its process no longer exists".
//
// The evidence was already in the process: writerProcessGone() probes the owner pid
// (ESRCH ⇒ proven dead) but was only reached from the cancel path. Status branched on
// heartbeat AGE alone.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  inflightNoteKind,
  provenDeadStatusNote,
} from "../../services/download-status-proven-dead.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("#1479 which note to render", () => {
  it("a PROVEN-gone writer gets the proven-dead note", () => {
    expect(
      inflightNoteKind({ status: "downloading", staleInflight: true, provenGone: true }),
    ).toBe("proven-dead");
  });

  it("proven-gone wins even when the heartbeat is not yet stale", () => {
    // The pid probe is the stronger evidence; waiting for the heartbeat to age would
    // keep reporting a dead transfer as live for no reason.
    expect(
      inflightNoteKind({ status: "downloading", staleInflight: false, provenGone: true }),
    ).toBe("proven-dead");
  });

  it("UNKNOWN keeps the cautious wording — the whole point", () => {
    // writerProcessGone returns undefined when there is no recorded pid or the probe
    // failed. #761: a reconnect can interrupt persistence, so a missed heartbeat alone
    // does not prove the transfer stopped, and claiming death would be the same
    // over-reach in the other direction.
    expect(
      inflightNoteKind({ status: "downloading", staleInflight: true, provenGone: undefined }),
    ).toBe("stale");
  });

  it("a live writer with a stale heartbeat stays cautious", () => {
    expect(
      inflightNoteKind({ status: "downloading", staleInflight: true, provenGone: false }),
    ).toBe("stale");
  });

  it("says nothing when the record is not in flight", () => {
    for (const status of ["completed", "cancelled", "failed", undefined]) {
      expect(inflightNoteKind({ status, staleInflight: true, provenGone: true })).toBe("none");
    }
  });

  it("says nothing for a healthy in-flight record", () => {
    expect(inflightNoteKind({ status: "downloading" })).toBe("none");
  });
});

describe("#1479 the proven-dead note", () => {
  const note = () => provenDeadStatusNote({ staleForMs: 102_000 });

  it("states plainly that the transfer is not running", () => {
    expect(note()).toMatch(/NOT running/);
    expect(note()).toMatch(/no longer\s+exists/);
  });

  it("gives the EVIDENCE, not just the verdict", () => {
    // A caller told moments ago not to touch this download needs to know why the
    // answer changed.
    expect(note()).toMatch(/probed by pid/);
    expect(note()).toMatch(/died with its session/);
  });

  it("does not repeat the do-not-act caution it replaces", () => {
    expect(note()).not.toMatch(/may still be running/);
    expect(note()).not.toMatch(/Do not report this download as failed or missing/);
  });

  it("says a re-issue is safe, because nothing is writing the file", () => {
    expect(note()).toMatch(/Nothing is writing this file/);
    expect(note()).toMatch(/safe to re-issue/);
  });

  it("reports how long ago the heartbeat stopped when known", () => {
    expect(note()).toMatch(/heartbeat stopped 102s ago/);
    // and omits the clause rather than printing a bogus 0s
    expect(provenDeadStatusNote({})).not.toMatch(/heartbeat stopped/);
    expect(provenDeadStatusNote({ staleForMs: 0 })).not.toMatch(/heartbeat stopped/);
  });

  it("does NOT claim a Manager dispatch is dead — only its local owner", () => {
    // The server-side fetch runs elsewhere; declaring it dead would be the same
    // over-reach this issue is about, pointed the other way.
    const m = provenDeadStatusNote({ staleForMs: 102_000, viaManager: true });
    expect(m).toMatch(/SERVER-side fetch may still\s+be running/);
    expect(m).toMatch(/only the local record's owner is proven gone/);
    expect(m).not.toMatch(/safe to re-issue/);
    expect(m).toMatch(/list_local_models/);
  });
});

describe("#1479 WIRING", () => {
  const jobs = readFileSync(join(HERE, "../../services/download-jobs.ts"), "utf8");
  const tool = readFileSync(join(HERE, "../../tools/model-management.ts"), "utf8");

  it("the pid verdict is carried onto the job view", () => {
    expect(jobs).toMatch(/writerProvenGone\?: boolean;/);
    expect(jobs).toMatch(/writerProvenGone: writerProcessGone\(rec\) === true \? true : undefined/);
  });

  it("only TRUE is carried — 'cannot tell' must not render as death", () => {
    // The projection maps undefined/false to absent, so the renderer can never read a
    // failed probe as proof.
    expect(jobs).not.toMatch(/writerProvenGone: writerProcessGone\(rec\),/);
  });

  it("status renders through the shared decision", () => {
    expect(tool).toMatch(
      /import \{[\s\S]*?inflightNoteKind,[\s\S]*?\} from "\.\.\/services\/download-status-proven-dead\.js";/,
    );
    expect(tool).toMatch(/const noteKind = inflightNoteKind\(\{/);
    expect(tool).toMatch(/noteKind === "proven-dead"/);
  });

  it("the STATUS LINE agrees with the note", () => {
    // The note alone would leave the reply contradicting itself: "still streaming"
    // immediately followed by "this transfer is NOT running".
    expect(tool).toMatch(/j\.writerProvenGone === true/);
    expect(tool).toMatch(/NOT running — the owning process is gone/);
  });

  it("the cautious stale wording survives for the unproven case", () => {
    expect(tool).toMatch(/heartbeat stale for/);
    expect(tool).toMatch(/the transfer may still be running/);
  });
});
