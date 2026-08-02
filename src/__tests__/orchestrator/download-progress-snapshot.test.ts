// #717: a reconnecting panel can still show rows pushed by a previous
// orchestrator. A fresh process owns a new, empty progress directory, so its
// first empty poll must be delivered as a reconciliation snapshot.

import { describe, expect, it } from "vitest";
import { DownloadProgressSnapshots } from "../../orchestrator/index.js";

describe("download progress snapshot emission (#717)", () => {
  it("gives a fresh/reconnected panel an empty snapshot that clears stale tray rows", () => {
    // The tray was rendered from the prior orchestrator's last push. The new
    // process cannot inspect that old process's progress dir, so its hello
    // reconciliation must replace (not interpret) the stale rows.
    let panelTray: Array<Record<string, unknown>> = [
      { id: "old-model", status: "downloading", percent: 56 },
    ];
    const snapshots = new DownloadProgressSnapshots();

    panelTray = snapshots.forPanel();
    expect(panelTray).toEqual([]);
    expect(snapshots.record([])).toBe(true); // first poll broadcasts once too
  });

  it("does not broadcast unchanged empty state on later polls, while each hello can reconcile", () => {
    const snapshots = new DownloadProgressSnapshots();

    expect(snapshots.record([])).toBe(true);
    expect(snapshots.record([])).toBe(false);
    expect(snapshots.forPanel()).toEqual([]);
    expect(snapshots.forPanel()).toEqual([]); // another reconnect gets the same correction
  });

  it("passes through real active and terminal rows without inventing outcomes", () => {
    const snapshots = new DownloadProgressSnapshots();
    const active = [{ id: "model-a", status: "downloading", percent: 56 }];
    const terminal = [{ id: "model-a", status: "done", percent: 100 }];

    expect(snapshots.record(active)).toBe(true);
    expect(snapshots.forPanel()).toEqual(active);
    expect(snapshots.record(active)).toBe(false);
    expect(snapshots.record(terminal)).toBe(true);
    expect(snapshots.forPanel()).toEqual(terminal);
  });
});
