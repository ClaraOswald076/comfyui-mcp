import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  BRIDGE_CMD_MIN_PANEL_VERSION,
  BRIDGE_CAPABILITY_MIN_PANEL_VERSION,
  requiredPanelVersion,
} from "../../services/ui-bridge.js";

/**
 * #1384 — the smoke's mock panel must stay new enough to be allowed to write.
 *
 * The reported failure was not a bug in the product: the mock's hello carried no
 * `panel_version`, so the graph-write fence correctly refused `graph_clear` before the
 * mock executor ever saw it, and the smoke reported a capability failure that was really a
 * harness failure. Pinning a literal version in the script fixes today and rots tomorrow —
 * the floor had ALREADY moved twice (0.11.30 → 0.11.35, then 0.13.0 for #1359) while the
 * reporter's suggested 0.11.35 was being written down.
 *
 * So the number is ratcheted against the product's own derived minimum. Raising any fence
 * fails here, in a test that names the file to edit, instead of surfacing later as a smoke
 * that refuses every write for a reason nobody connects to a table three modules away.
 */
const SMOKE = new URL("../../../scripts/codex-knowledge-parity-smoke.mjs", import.meta.url);

const source = (): string => readFileSync(SMOKE, "utf8");

const declared = (name: string): string => {
  const m = source().match(new RegExp(`const ${name} = "([^"]+)"`));
  expect(m, `${name} must be declared in the smoke script`).not.toBeNull();
  return m![1];
};

const parse = (v: string): number[] => v.split(".").map(Number);
const atLeast = (have: string, want: string): boolean => {
  const a = parse(have);
  const b = parse(want);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return true;
};

describe("#1384 — the knowledge-parity mock keeps up with the fences", () => {
  it("the mock's panel version satisfies every command and capability minimum", () => {
    const mock = declared("MOCK_PANEL_VERSION");
    const required = requiredPanelVersion();
    expect(
      atLeast(mock, required),
      `MOCK_PANEL_VERSION is ${mock}, but the orchestrator now requires ${required}. ` +
        `Raise it in scripts/codex-knowledge-parity-smoke.mjs — otherwise the smoke's ` +
        `graph writes are refused by the fence and the run reports a capability failure ` +
        `that is really a harness failure.`,
    ).toBe(true);
  });

  it("…including any fence added after this test was written", () => {
    // requiredPanelVersion() is an aggregate, so a new entry BELOW the current maximum
    // does not move it and the test above would not notice. Checking every entry
    // individually is what makes this a ratchet rather than a snapshot of one number.
    const mock = declared("MOCK_PANEL_VERSION");
    const all = [
      ...Object.entries(BRIDGE_CMD_MIN_PANEL_VERSION),
      ...Object.entries(BRIDGE_CAPABILITY_MIN_PANEL_VERSION),
    ];
    expect(all.length, "the tables must not be empty, or this asserts nothing").toBeGreaterThan(5);
    const behind = all.filter(([, min]) => !atLeast(mock, min));
    expect(behind, `the mock (${mock}) is older than: ${behind.map(([k]) => k).join(", ")}`).toEqual(
      [],
    );
  });

  it("the mock advertises BOTH write-fence capabilities, not just a version", () => {
    // A version alone does not pass the write fence: the dispatch-time stamp check and the
    // after-await write-boundary recheck are separate handshake capabilities, and a mock
    // claiming a new version while advertising neither is a panel that lies — which is a
    // worse harness than one that is simply old.
    const s = source().replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*/g, "");
    for (const cap of Object.keys(BRIDGE_CAPABILITY_MIN_PANEL_VERSION)) {
      expect(s, `the mock hello must advertise ${cap}`).toMatch(
        new RegExp(`${cap}:\\s*true`),
      );
    }
    // …and a workflow uuid for the per-command stamp to fence on.
    expect(s).toMatch(/workflow_uuid: MOCK_WORKFLOW_UUID/);
    expect(declared("MOCK_WORKFLOW_UUID")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("the mock's socket sends an Origin, because a real panel's does", () => {
    // The THIRD fence this mock had to stop failing. A browser sets Origin on the upgrade
    // and forbids page JS from overriding it, so the bridge treats it as trusted
    // provenance and refuses every graph EDIT without one. The `ws` library sends none by
    // default, so the mock read as a relay connection of unknown provenance and the smoke
    // reported a knowledge failure that was really its own handshake.
    //
    // Asserted here rather than left to the run, because the failure mode is a PASS on the
    // read-only half with "built nodes on the live canvas: NO" — which looks like a model
    // that did not try.
    // NOT comment-stripped, unlike the assertions above: the naive `//.*` strip treats the
    // `//` in `ws://127.0.0.1` as a line comment and deletes the rest of the line — the
    // construction being asserted. A comment cannot satisfy this pattern anyway, because
    // the match must START at `new WebSocket(`.
    expect(source()).toMatch(/new WebSocket\([\s\S]{0,200}?headers:\s*\{\s*Origin:/);
  });

  it("the mock implements the commands the scenario drives", () => {
    // graph_load was missing, so the preferred one-shot panel_load_workflow(pack:…) path
    // could not complete and the smoke could only reach the capability by the long route —
    // measuring a fallback while reporting on the primary.
    const s = source();
    for (const cmd of ["graph_clear", "graph_load", "graph_get_state"]) {
      expect(s, `the mock executor must implement ${cmd}`).toMatch(new RegExp(`${cmd}:\\s*[({]`));
    }
  });
});
