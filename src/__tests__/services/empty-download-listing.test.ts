// #1420 — AN EMPTY LISTING IS NOT PROOF THAT NOTHING IS RUNNING.
//
// `download_model action:"status"` answered `No downloads are being tracked.` while
// two multi-GB transfers were mid-flight. The reporter concluded ~24 GB had been
// lost and told their user so, then re-issued and found both jobs alive under their
// original ids. The same call ~40s later listed both, so the empty answer was
// transient — the one thing a bare sentence cannot express.
//
// The harm was not the empty list; it was a confident sentence with no room in it
// for the state the caller was actually in.

import { describe, expect, it } from "vitest";
import { emptyDownloadListingNote } from "../../services/empty-download-listing.js";

const NOW = 1_800_000_000_000;

describe("#1420 the empty listing refuses to claim absence", () => {
  const note = emptyDownloadListingNote({ now: NOW });

  it("scopes the claim to this session's store, not to the world", () => {
    expect(note).toContain("THIS session's record store");
    expect(note).toContain('NOT the same as "nothing is downloading"');
  });

  it("says outright it cannot distinguish the two states", () => {
    expect(note.toLowerCase()).toContain("cannot tell the two apart");
  });

  it("forbids the conclusion the reporter drew, in the words they drew it in", () => {
    // They did not just believe it — they told their user the transfer was lost.
    expect(note).toContain("DO NOT conclude");
    expect(note).toContain("do not tell the user so");
  });

  it("names the staging behaviour that made their disk check agree with the wrong answer", () => {
    // Looking at models/<subfolder> is the obvious corroboration, and it is empty
    // for a healthy in-flight transfer too.
    expect(note).toContain("staged OUTSIDE models/<subfolder>");
  });

  it("gives the two cheap checks, and says re-downloading is not one of them", () => {
    expect(note).toContain("download tray");
    expect(note).toContain("ADOPTED, not duplicated");
    expect(note).toContain("starting over is not");
  });

  it("does not use the old bare sentence", () => {
    expect(note).not.toBe("No downloads are being tracked.");
  });
});

describe("#1420 the store's age is offered only when it explains something", () => {
  it("names a FRESH store — the reconnect case, stated concretely", () => {
    const note = emptyDownloadListingNote({ now: NOW, storeCreatedMs: NOW - 12_000 });
    expect(note).toContain("created 12s ago");
    expect(note).toContain("started before then was never in it");
  });

  it("renders minutes for an older-but-still-fresh store", () => {
    const note = emptyDownloadListingNote({ now: NOW, storeCreatedMs: NOW - 5 * 60_000 });
    expect(note).toContain("created 5m ago");
  });

  it("says nothing about age for a LONG-LIVED store — it explains nothing there", () => {
    const note = emptyDownloadListingNote({ now: NOW, storeCreatedMs: NOW - 60 * 60_000 });
    expect(note).not.toMatch(/store was created \d+[smh] ago/);
    // …but the rest of the honesty still applies: the store being old does not make
    // an empty listing proof either.
    expect(note).toContain("DO NOT conclude");
  });

  it("treats an UNKNOWN store age as unknown, never as old or fresh", () => {
    const unknown = emptyDownloadListingNote({ now: NOW });
    expect(unknown).not.toMatch(/store was created \d+[smh] ago/);
    expect(unknown).toContain("created fresh on each orchestrator start"); // the general fact
  });

  it("ignores a nonsensical creation time rather than rendering a negative age", () => {
    for (const bad of [0, -1, NOW + 60_000]) {
      const note = emptyDownloadListingNote({ now: NOW, storeCreatedMs: bad });
      expect(note, String(bad)).not.toMatch(/store was created -?\d+[smh] ago/);
    }
  });
});
