// #1539 — `panel_install_node` advertised `repository` (git URL) → "a nightly install"
// without qualification, and an unlisted repo cannot install that way on Manager v4.
//
// MEASURED, not inferred, against a live ComfyUI-Manager **V4.2.2** on 2026-08-14. The
// request carried the exact payload `buildInstallRequest` produces for a git URL —
// `{ id: <repo name>, version: "nightly", selected_version: "nightly", repository: <url>,
// channel: "dev", mode: "cache" }` — posted to `/v2/manager/queue/task`, which is the
// route the panel uses. The Manager ACCEPTED it (200, queued), then failed it at
// processing time with:
//
//   Node 'cmcp-1539-does-not-exist@nightly' not found in
//   [ManagerChannel.dev, ManagerDatabaseSource.cache]
//
// and its own history record shows `repository` present in the stored params. So v4
// resolves by `id` against its registry EVEN WHEN `repository` is supplied and
// `selected_version` is `nightly` — the exact case its schema documents as
// "repository required if selected_version is nightly". The URL is carried and ignored.
//
// That error is byte-for-byte the shape the reporter saw (`comfyui-anima-ipadapter@nightly`).
//
// The probe used a URL that does not exist, so neither outcome could install anything:
// registry-validated → rejected before any fetch; repository honoured → clone of a
// non-existent repo fails. Nothing landed in custom_nodes.
//
// So the limitation is UPSTREAM, our payload is correct, and what was ours is the
// unqualified promise in the tool description. These tests pin the corrected claim —
// a silent revert to "git URL → nightly install" would restore an expectation the path
// cannot meet on v4.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs } = await import("../../orchestrator/panel-tools.js");

function installNodeDef() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_install_node");
  if (!def) throw new Error("panel_install_node is not registered");
  return def;
}

describe("panel_install_node states the v4 git-install limit (#1539)", () => {
  it("names the limitation, the version it was measured on, and that it is upstream", () => {
    const text = installNodeDef().description ?? "";
    expect(text).toMatch(/Manager v4/i);
    expect(text).toMatch(/V4\.2\.2/, "the measured version, so a later Manager can be re-checked");
    expect(text).toMatch(/UPSTREAM limitation/i);
    // The distinguishing fact: the URL is sent, it is simply not used to clone.
    expect(text).toMatch(/does not clone from it/i);
  });

  it("quotes the ACTUAL error, so the symptom is recognisable when it happens", () => {
    // The reporter's confusion was that `<name>@nightly` looked like evidence the URL had
    // been dropped. Quoting the real message ties the symptom to this explanation.
    const text = installNodeDef().description ?? "";
    expect(text).toMatch(/not found in \[ManagerChannel\.dev, ManagerDatabaseSource\.cache\]/);
  });

  it("gives the caller something to DO, and does not strand them", () => {
    const text = installNodeDef().description ?? "";
    expect(text).toMatch(/clone it into custom_nodes yourself/i);
    // 3.x is not the same as v4 here, and saying so stops a "it worked before" report
    // reading as a regression on our side.
    expect(text).toMatch(/3\.x installs an unlisted URL natively/i);
  });

  it("does NOT promise a git URL installs unconditionally", () => {
    // The sentence this issue is about. `repository` is still offered — it is the right
    // field for a listed repo — but the unqualified promise is gone.
    const text = installNodeDef().description ?? "";
    expect(text).toMatch(/ONLY WORKS FOR A REPO THE MANAGER ALREADY KNOWS/i);
  });

  it("the repository PARAM carries the caveat too", () => {
    // A caller reading the schema may never see the tool blurb. The def exposes `schema`
    // (not `inputSchema`) — asserted against the real shape rather than a guessed one,
    // after the first version of this test read an undefined field and failed for that
    // reason instead of the one it is about.
    const def = installNodeDef() as unknown as {
      schema?: Record<string, { description?: string; _def?: { description?: string } }>;
    };
    const repo = def.schema?.repository;
    const desc = repo?.description ?? repo?._def?.description ?? "";
    expect(desc, "the repository param must carry the v4 caveat").toMatch(
      /unlisted URL is rejected|registry already lists/i,
    );
  });
});
