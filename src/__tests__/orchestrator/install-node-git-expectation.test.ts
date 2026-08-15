// #1539 — `panel_install_node` took a git `repository` URL for a pack the reporter had
// just found with `panel_search_nodes`, answered `queued: true`, and the Manager queue
// then failed it with
//
//   Node 'comfyui-anima-ipadapter@nightly' not found in
//   [ManagerChannel.dev, ManagerDatabaseSource.cache]
//
// The first pass read that as an UPSTREAM limit — "v4 will not install a repo its
// registry does not list" — and shipped a description saying so. This commit measured
// that claim and it is FALSE for the report's own input.
//
// ## What was measured (2026-08-14, live ComfyUI-Manager V4.2.2 + its own source)
//
// 1. THE PACK IS LISTED. `Wenaka2004/comfyui-anima-ipadapter` is present in the
//    `default` channel's custom-node-list.json (5887 packs) AND in the live rig's own
//    cached copy of it. It is ABSENT from the `dev` channel list (1210 packs). Those
//    two lists are not a superset/subset pair — they share 3 entries.
//
// 2. WE ASKED `dev`. The panel's `buildInstallRequest` defaults the v4 git-URL payload
//    to `channel: "dev"` while defaulting the registry-ID payload — and both 3.x
//    shapes — to `"default"`. The Manager's error names the channel the REQUEST chose.
//
// 3. THE CHANNEL IS WHAT THE LOOKUP READS. `install_by_id` (glob/manager_core.py) for a
//    `nightly` spec does `get_custom_nodes(channel, mode)` → `load_nightly` →
//    `get_data_by_mode(mode, 'custom-node-list.json', channel_url)`, keys that map by
//    the bare repo name (`y.split('/')[-1]`), and clones `the_node['repository']` — the
//    CHANNEL's URL. The `repository` we send is stored in the task params and never
//    read on that path.
//
// 4. REPRODUCED AND ISOLATED on the live V4.2.2 by posting the panel's exact payload to
//    `/v2/manager/queue/task`: `channel:"dev"` → the reporter's error verbatim;
//    `channel:"default"` → the same failure naming `ManagerChannel.default`;
//    `channel:"default", mode:"remote"` → the same again naming `.remote`. The server
//    log shows all three reads landing on the package-BUNDLED node list, because
//    `is_manager_pip_package()` sends `get_data_by_mode` down its offline branch
//    unconditionally: a pip v4 reads the cache file for that exact channel URL or the
//    bundled snapshot, and never fetches. That rig is configured to a non-default
//    channel URL, so it has no `default` cache to hit.
//
// ## What that means for the two remedies the report proposed
//
// ROUTE THE URL THROUGH `install_custom_node` (source:"git") — NOT DONE. That path
// clones into the ORCHESTRATOR's configured ComfyUI; this tool drives whatever ComfyUI
// the PANEL is bound to, and those need not be the same install. Reporting a write into
// an install the running server never reads is a failure this repo has shipped before.
// The tool is still NAMED, with its precondition stated.
//
// REFUSE BEFORE DISPATCH WHEN THE REGISTRY DOES NOT LIST IT — NOT DONE, and this is the
// one the measurement kills. The only registry oracle reachable over the bridge is
// `nodes_search`, and it CANNOT answer this question:
//   - it reads `extension-node-map.json`, a different file from the node list the
//     install resolves against, cached separately and measured stale-by-a-different-
//     amount on the same rig;
//   - it is not channel-scoped at all — `getmappings?mode=cache` and the same route
//     with `&channel=dev` returned byte-identical bodies — so it cannot see the axis
//     that actually decides the outcome;
//   - and against the REPORT'S OWN INPUT it answers "listed", because that search is
//     literally where the reporter got the URL. A guard keyed on it would never have
//     fired on the case it was written for, while reading as good coverage.
//
// So the reply is not corrected by a refusal here. The REQUEST is corrected instead:
// the git-URL route stops asking a channel nobody chose.
import { describe, expect, it, vi } from "vitest";
import { nodesInstallCommandArgs } from "../../services/node-management.js";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

/** The reporter's own repository, verbatim from the issue. */
const REPORTED_URL = "https://github.com/Wenaka2004/comfyui-anima-ipadapter";
const TAB = "11111111-2222-3333-4444-555555555555";

function installNodeDef() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_install_node");
  if (!def) throw new Error("panel_install_node is not registered");
  return def;
}

describe("the git-URL install asks a channel that can list the pack (#1539)", () => {
  it("THE REPORT'S OWN INPUT: a bare repository URL no longer asks the 'dev' channel", () => {
    // The whole bug in one assertion. `dev` lists 1210 packs and shares 3 with the
    // 5887-pack default list; the reporter's pack is in default, not dev.
    const out = nodesInstallCommandArgs({ repository: REPORTED_URL });
    expect(out.repository).toBe(REPORTED_URL);
    expect(out.version).toBe("nightly");
    expect(out.channel).toBe("default");
    expect(out.channel).not.toBe("dev");
  });

  it("a URL arriving as `id` takes the same channel — both spellings reach the same route", () => {
    // #789 reroutes a URL-shaped `id` onto the from-source path. If only the
    // `repository` spelling were fixed, the identical request would still fail when
    // written the other way, which is how a half-fix survives review.
    const out = nodesInstallCommandArgs({ id: REPORTED_URL });
    expect(out.id).toBeUndefined();
    expect(out.repository).toBe(REPORTED_URL);
    expect(out.channel).toBe("default");
  });

  it("MUST STILL WORK: an explicit channel is the caller's, including 'dev'", () => {
    // The over-broad direction of this change would be to force "default" always,
    // which un-ships every pack that genuinely lives on another channel — 1207 of
    // dev's 1210 entries are not in default, so this is a real population, not a
    // hypothetical one.
    const out = nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "dev" });
    expect(out.channel).toBe("dev");
    const forked = nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "forked" });
    expect(forked.channel).toBe("forked");
  });

  it("MUST STILL WORK: a registry-id install is not touched at all", () => {
    // The panel already defaults THAT payload to "default"; sending a value from here
    // would be a change with no measurement behind it.
    const bare = nodesInstallCommandArgs({ id: "comfyui-kjnodes", version: "latest" });
    expect(bare.channel).toBeUndefined();
    expect(bare.repository).toBeUndefined();
    const chosen = nodesInstallCommandArgs({ id: "comfyui-kjnodes", channel: "recent" });
    expect(chosen.channel).toBe("recent");
  });

  it("a BLANK channel counts as unset, because the panel's `||` reads it that way", () => {
    // `channel || "dev"` substitutes dev for "" and "   ". Forwarding either would land
    // straight back on the channel this change exists to stop asking for — a fix that
    // passes a naive equality test while doing nothing.
    expect(nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "" }).channel).toBe(
      "default",
    );
    expect(nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "   " }).channel).toBe(
      "default",
    );
  });

  it("does not disturb the other dispatch fields", () => {
    const out = nodesInstallCommandArgs({
      repository: REPORTED_URL,
      version: "abc123",
      mode: "cache",
    });
    expect(out.version).toBe("abc123");
    expect(out.mode).toBe("cache");
    expect(out.conflict).toBeUndefined();
  });

  it("the conflict refusal still wins over any channel handling", () => {
    const out = nodesInstallCommandArgs({ id: "comfyui-kjnodes", repository: REPORTED_URL });
    expect(out.conflict).toMatch(/BOTH/);
    expect(out.channel).toBeUndefined();
  });
});

describe("the channel it picked is DISCLOSED, never silent (#1539 review P1)", () => {
  // Review, correctly: with default and dev near-disjoint, NO single default is right,
  // so the 1207 dev-only packs are on the losing side of whichever one is chosen. The
  // proposed remedy was to retry the other channel on a not-found. That premise is true
  // about the FIRST attempt — a not-found returns before any clone — and false about
  // the SECOND: v4 resolves by BARE REPO NAME and clones the CHANNEL's recorded URL, and
  // 35 bare names exist in both channels under DIFFERENT authors. An automatic retry
  // would sometimes install a repository the caller never named. So the choice is taken,
  // disclosed, and reversible in one argument instead.

  it("names the channel asked and refuses to generalise a miss beyond it", () => {
    const note = nodesInstallCommandArgs({ repository: REPORTED_URL }).note ?? "";
    expect(note).toMatch(/asked ComfyUI-Manager's "default" channel/i);
    // The P1-2 claim, in the note's own words: a miss is evidence about ONE list.
    expect(note).toMatch(/rules the pack out of "default" ONLY/);
    expect(note).toMatch(/says NOTHING about/i);
    // And the way out, spelled as an argument the caller can actually pass.
    expect(note).toMatch(/channel:"dev"/);
  });

  it("says WHY it does not retry the other channel for you", () => {
    // Without this the disclosure reads as laziness, and the next reviewer re-proposes
    // the retry. The hazard is specific and measured, so it is stated.
    const note = nodesInstallCommandArgs({ repository: REPORTED_URL }).note ?? "";
    expect(note).toMatch(/NOT retried for you on purpose/i);
    expect(note).toMatch(/BARE REPO ?NAME/i);
    expect(note).toMatch(/DIFFERENT authors/i);
    expect(note).toMatch(/could install a repository you did not name/i);
  });

  it("discloses even when no OTHER note applies — an explicit version has none", () => {
    // `norm.note` rides only the "latest"→nightly rewrite. A caller passing an explicit
    // ref gets no such note, and would otherwise have a channel chosen for them in
    // silence — the exact thing this is meant to prevent.
    const out = nodesInstallCommandArgs({ repository: REPORTED_URL, version: "abc123" });
    expect(out.version).toBe("abc123");
    expect(out.note ?? "").toMatch(/asked ComfyUI-Manager's "default" channel/i);
  });

  it("keeps the #789 nightly-rewrite note as well, not instead", () => {
    const note = nodesInstallCommandArgs({ repository: REPORTED_URL }).note ?? "";
    expect(note).toMatch(/is a git repository URL, so this was queued as a from-source/i);
    expect(note).toMatch(/asked ComfyUI-Manager's "default" channel/i);
  });

  it("says NOTHING about the channel when the caller chose one themselves", () => {
    // Disclosing a choice the caller made is noise, and would misreport whose choice it
    // was. The nightly-rewrite note is still theirs to receive.
    const chosen = nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "dev" });
    expect(chosen.note ?? "").not.toMatch(/asked ComfyUI-Manager's/i);
    expect(chosen.note ?? "").toMatch(/from-source/i);
  });

  it("says nothing about the channel on a registry-id install", () => {
    // That route never had a channel chosen for it here.
    expect(nodesInstallCommandArgs({ id: "comfyui-kjnodes" }).note ?? "").not.toMatch(
      /asked ComfyUI-Manager's/i,
    );
  });
});

describe("panel_install_node actually DISPATCHES the channel (#1539 wiring)", () => {
  // A green unit test on nodesInstallCommandArgs proves the helper computes a channel,
  // never that the value reaches the panel. This drives the real tool definition and
  // reads the command object off the bridge; deleting the `...cmdArgs` spread at the
  // call site fails it, which a helper-only suite does not notice.
  async function dispatch(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    let sent: Record<string, unknown> | undefined;
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "nodes_install") {
          sent = cmd;
          return { queued: true, pending: true, id: "comfyui-anima-ipadapter", dialect: "v2" };
        }
        // Leave the #1129 dropped-enqueue probe inconclusive so it appends nothing.
        return { status: { in_progress_count: 0, is_processing: true } };
      },
      tabIncarnation: () => "inc-A",
      push: () => 1,
      canReach: (id: string) => id === TAB,
      isHeadless: () => false,
      tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => TAB,
      refreshWorkflowUuid: () => true,
      workflowUuidFor: () => ({ known: false }),
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res: ToolResult = await installNodeDef().handler(args as never, ctx);
    expect(res.isError).not.toBe(true);
    if (!sent) throw new Error("nodes_install was never dispatched");
    return sent;
  }

  it("sends channel 'default' to the panel for the reporter's request", async () => {
    const cmd = await dispatch({ repository: REPORTED_URL });
    expect(cmd.cmd).toBe("nodes_install");
    expect(cmd.repository).toBe(REPORTED_URL);
    expect(cmd.channel).toBe("default");
  });

  it("relays an explicit channel unchanged", async () => {
    const cmd = await dispatch({ repository: REPORTED_URL, channel: "dev" });
    expect(cmd.channel).toBe("dev");
  });

  it("the channel disclosure REACHES THE CALLER, not just the args object", async () => {
    // A note computed and never appended is the #1129 failure again — that probe
    // shipped once and never ran. This asserts on the tool's returned TEXT.
    let sent: Record<string, unknown> | undefined;
    const bridge = {
      send: async (cmd: Record<string, unknown>) => {
        if (cmd.cmd === "nodes_install") {
          sent = cmd;
          return { queued: true, pending: true, id: "comfyui-anima-ipadapter", dialect: "v2" };
        }
        return { status: { in_progress_count: 0, is_processing: true } };
      },
      tabIncarnation: () => "inc-A",
      push: () => 1,
      canReach: (id: string) => id === TAB,
      isHeadless: () => false,
      tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
      resolveActiveTabId: () => TAB,
      refreshWorkflowUuid: () => true,
      workflowUuidFor: () => ({ known: false }),
      tabCanMutateGraph: () => true,
      tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
    } as unknown as PanelToolCtx["bridge"];
    const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
    const res: ToolResult = await installNodeDef().handler(
      { repository: REPORTED_URL } as never,
      ctx,
    );
    const text = res.content.map((c) => (c as { text?: string }).text ?? "").join(" ");
    expect(sent?.channel).toBe("default");
    expect(text).toMatch(/asked ComfyUI-Manager's "default" channel/i);
    expect(text).toMatch(/rules the pack out of "default" ONLY/);
  });
});

describe("panel_install_node describes what was measured (#1539)", () => {
  // A REVERSION FENCE, and nothing more: every asserted string lives in the definition
  // under test, so a wrong claim written consistently in both places would pass. The
  // truth of these claims rests on the run recorded at the top of this file.

  it("names the version measured and the mechanism that actually decides the outcome", () => {
    const text = installNodeDef().description ?? "";
    expect(text).toMatch(/V4\.2\.2/, "so a later Manager can be re-checked, not assumed");
    expect(text).toMatch(/IS NOT THE URL THAT GETS CLONED/i);
    expect(text).toMatch(/bare repo name/i);
    expect(text).toMatch(/whether the repo is listed in the channel this call asks for/i);
  });

  it("quotes the error with the channel as a VARIABLE, not hard-coded to dev", () => {
    // The old text quoted `[ManagerChannel.dev, ManagerDatabaseSource.cache]` literally.
    // After this change the tool no longer asks for dev, so that quote would send a
    // reader looking for a string their own call can no longer produce.
    const text = installNodeDef().description ?? "";
    expect(text).toMatch(/ManagerChannel\.<channel>/);
    expect(text).not.toMatch(/\[ManagerChannel\.dev, ManagerDatabaseSource\.cache\]/);
  });

  it("owns the part that was ours instead of calling the whole thing upstream", () => {
    const text = installNodeDef().description ?? "";
    expect(text).toMatch(/WHAT WAS OURS/);
    expect(text).toMatch(/used to ask the 'dev' channel/i);
    // The retracted claim must be gone, not merely softened: it was measured false
    // against the reporter's own pack, which IS listed.
    expect(text).not.toMatch(/UPSTREAM limitation/i);
    expect(text).not.toMatch(/DOES NOT INSTALL A REPO THE MANAGER'S REGISTRY DOES NOT LIST/i);
    expect(text).not.toMatch(/being listed is necessary/i);
  });

  it("does NOT let the fix read as a guarantee", () => {
    // The failure mode of a fix like this is a description that now over-promises in
    // the opposite direction. Both limits that were measured have to survive.
    const text = installNodeDef().description ?? "";
    expect(text).toMatch(/STILL NOT GUARANTEED/);
    expect(text).toMatch(/non-default channel URL still resolves from that stale bundled list/i);
    expect(text).toMatch(/`mode` is inert/i);
    expect(text).toMatch(/not measured/i);
  });

  it("does NOT turn a one-channel miss into a verdict about the pack (review P1)", () => {
    // The shipped sentence said "the pack is absent from every channel this Manager can
    // read". A `default` miss establishes nothing about `dev` — the same class of
    // over-claim this PR retracted, handing out harmful recovery advice.
    const text = installNodeDef().description ?? "";
    expect(text).not.toMatch(/absent from every channel this Manager can read/i);
    expect(text).toMatch(/A NOT-FOUND RULES OUT ONE CHANNEL, NOT THE PACK/);
    expect(text).toMatch(/absent from the channel THIS CALL ASKED and nothing more/i);
    expect(text).toMatch(/will NOT retry another channel for you/i);
    expect(text).toMatch(/could install a repo you never named/i);
  });

  it("keeps the local-only precondition on the tool that CAN clone", () => {
    const text = installNodeDef().description ?? "";
    expect(text).toMatch(/install_custom_node/);
    expect(text).toMatch(/LOCAL ComfyUI/);
    expect(text).toMatch(/not necessarily the one the panel drives/i);
  });

  it("the LATER recovery advice still agrees with the caveat above it", () => {
    // Review precedent from the first pass: a contradiction a few sentences on talks a
    // user into a retry loop that cannot succeed. The advice now names the real reason
    // a retry is futile — absence from every readable channel — rather than "unlisted".
    const text = installNodeDef().description ?? "";
    const retryAdvice = text.slice(text.indexOf("a pack you installed that is absent"));
    expect(retryAdvice).toMatch(/resolves against ONE channel.s list/i);
    // Names the action that CAN change the outcome (a different channel) before the
    // one that gives up. The old wording said "clone it yourself instead of retrying",
    // which skipped straight past the retry that actually works.
    expect(retryAdvice).toMatch(/change the `channel` first/i);
    expect(retryAdvice).toMatch(/once the plausible channels are ruled out/i);
  });

  it("the repository and channel PARAMS carry it too", () => {
    // A caller reading the schema may never see the tool blurb.
    const def = installNodeDef() as unknown as {
      schema?: Record<string, { description?: string; _def?: { description?: string } }>;
    };
    const descOf = (k: string): string => {
      const f = def.schema?.[k];
      return f?.description ?? f?._def?.description ?? "";
    };
    expect(descOf("repository")).toMatch(/recorded but never cloned/i);
    expect(descOf("repository")).toMatch(/'default' channel unless you pass `channel`/i);
    expect(descOf("channel")).toMatch(/WHICH node list/i);
  });
});
