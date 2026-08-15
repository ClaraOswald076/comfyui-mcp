// #1616 — AN AMBIGUOUS BARE NAME IS REFUSED BEFORE DISPATCH, NOT PICKED.
//
// #1611 measured this hazard and DISCLOSED it; #1616 was split out to prevent it. The
// mechanism is unchanged and re-read at ComfyUI-Manager 4.2.2's own source
// (comfyui_manager/glob/manager_core.py), not inferred:
//
//   load_nightly      for y in x['files']: res[y.split('/')[-1]] = (x, False)
//   get_custom_nodes  NormalizedKeyDict; its get() keys on key.strip().lower()
//   install_by_id     the_node = custom_nodes.get(node_id)
//                     repo_url = the_node['repository']        # the CHANNEL's URL
//
// The `repository` a caller passes is stored in the task params and never read on this
// path, so what gets cloned is whatever the asked-for channel's list has under the bare
// repo name — which need not be the repository the caller named, and the install still
// reports success.
//
// ## What was measured, 2026-08-15, against all six published channel lists
//
// #1616 reports 65 colliding names (35 between `default` and `dev`). That count is
// case-SENSITIVE and the lookup is not — `NormalizedKeyDict.get` lowercases, so
// `comfyui_tagger` and `ComfyUI_tagger` are ONE name. Counted the way the lookup counts:
//
//   * 111 bare names resolve to different repositories depending on the channel
//   * 60 of those disagree between `default` and `dev` alone
//   * 28 are ambiguous WITHIN a single channel — a class #1616 does not mention. Two
//     entries under one name collapse onto one key (`load_nightly` overwrites on an
//     exact-case duplicate, `NormalizedKeyDict` on a case-variant one) and the survivor
//     is upstream list order, so no second channel is needed to hand back someone
//     else's repository.
//
// ## What the guard deliberately does NOT do
//
// It fires only on the channel THIS code defaulted to. A caller who names a channel made
// the choice themselves and gets the collision named instead — which is also the escape
// hatch from a stale snapshot, since a refusal a caller cannot get past would be a worse
// tool than the hazard it prevents.
import { describe, expect, it, vi } from "vitest";
import { nodesInstallCommandArgs } from "../../services/node-management.js";
import {
  AMBIGUOUS_BARE_NAMES,
  ambiguousBareNameRefusal,
  bareNameAmbiguity,
  gitHostOf,
  managerBareName,
  ownerRepoOf,
} from "../../services/manager-bare-name-collisions.js";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

const TAB = "11111111-2222-3333-4444-555555555555";

// `ComfyUI-BiRefNet` is three different authors' repository depending on the channel:
// default -> hieuck, dev -> MohammadAboulEla, legacy -> viperyl.
const DEV_AUTHORS = "https://github.com/mohammadaboulela/ComfyUI-BiRefNet";
const DEFAULT_AUTHORS = "https://github.com/hieuck/ComfyUI-BiRefNet";
/** The reporter's pack from #1539 — a git URL whose name the snapshot has NOT seen collide. */
const UNCOLLIDING = "https://github.com/Wenaka2004/comfyui-anima-ipadapter";

function installNodeDef() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_install_node");
  if (!def) throw new Error("panel_install_node is not registered");
  return def;
}

/**
 * Drive the REAL tool against a fake bridge. A green unit test on nodesInstallCommandArgs
 * proves the helper computes a conflict, never that anyone acts on it — deleting the
 * `if (conflict) return fail(conflict)` line at the call site passes every unit assertion
 * in this file and fails only here.
 */
async function attemptInstall(
  args: Record<string, unknown>,
): Promise<{ sent: Record<string, unknown> | undefined; text: string; isError: boolean }> {
  let sent: Record<string, unknown> | undefined;
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "nodes_install") {
        sent = cmd;
        return { queued: true, pending: true, id: "ComfyUI-BiRefNet", dialect: "v2" };
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
  const res: ToolResult = await installNodeDef().handler(args as never, ctx);
  return {
    sent,
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
  };
}

describe("the ambiguous from-source install is refused, not picked (#1616)", () => {
  it("refuses the defaulted-channel install that would clone another author's repo", () => {
    const out = nodesInstallCommandArgs({ repository: DEV_AUTHORS });
    expect(out.conflict).toBeTruthy();
    // Refuses by REFUSING — no half state where the dispatch fields survive alongside it.
    expect(out.repository).toBeUndefined();
    expect(out.channel).toBeUndefined();
  });

  it("NAMES BOTH candidates rather than picking between them", () => {
    // The standing rule this exists to satisfy. A refusal that says only "ambiguous"
    // leaves the caller with nothing to act on.
    const conflict = nodesInstallCommandArgs({ repository: DEV_AUTHORS }).conflict ?? "";
    expect(conflict).toMatch(/mohammadaboulela\/ComfyUI-BiRefNet/i);
    expect(conflict).toMatch(/hieuck\/ComfyUI-BiRefNet/i);
    expect(conflict).toMatch(/BARE REPO NAME \("ComfyUI-BiRefNet"\)/);
  });

  it("hands back the channel that DOES resolve to the repository the caller named", () => {
    // Without this the refusal is a dead end. `dev` carries MohammadAboulEla's repo, so
    // that is the one argument that gets this caller what they actually asked for.
    const conflict = nodesInstallCommandArgs({ repository: DEV_AUTHORS }).conflict ?? "";
    expect(conflict).toMatch(/channel:"dev"/);
    expect(conflict).not.toMatch(/channel:"legacy"/);
  });

  it("says an explicit channel bypasses it, so a stale snapshot is escapable", () => {
    const conflict = nodesInstallCommandArgs({ repository: DEV_AUTHORS }).conflict ?? "";
    expect(conflict).toMatch(/naming any `channel` explicitly makes the choice yours/i);
    expect(conflict).toMatch(/measured 20\d\d-\d\d-\d\d/);
  });

  it("ALLOWS the caller who named the repository the asked-for channel carries", () => {
    // The same colliding NAME, the other author: `default` carries hieuck's, so there is
    // nothing to pick between. A guard that fired on the name alone would break every
    // correct install of a colliding pack — most of the 111 have a `default` entry.
    const out = nodesInstallCommandArgs({ repository: DEFAULT_AUTHORS });
    expect(out.conflict).toBeUndefined();
    expect(out.channel).toBe("default");
    expect(out.repository).toBe(DEFAULT_AUTHORS);
  });

  it("an EXPLICIT channel dispatches — and names the collision instead of refusing", () => {
    const out = nodesInstallCommandArgs({ repository: DEV_AUTHORS, channel: "legacy" });
    expect(out.conflict).toBeUndefined();
    expect(out.channel).toBe("legacy");
    expect(out.note ?? "").toMatch(/NAMED-CHANNEL COLLISION/);
    expect(out.note ?? "").toMatch(/viperyl\/ComfyUI-BiRefNet/);
  });

  it("an explicit channel that DOES carry the caller's repo adds nothing", () => {
    const out = nodesInstallCommandArgs({ repository: DEV_AUTHORS, channel: "dev" });
    expect(out.conflict).toBeUndefined();
    expect(out.note ?? "").not.toMatch(/NAMED-CHANNEL COLLISION/);
  });

  it("a BLANK channel is not an explicit one — it still refuses", () => {
    // The panel's `channel || "dev"` treats "" as absent, so forwarding it would land on
    // a channel nobody chose AND skip the guard. Both spellings count as unset.
    expect(nodesInstallCommandArgs({ repository: DEV_AUTHORS, channel: "" }).conflict).toBeTruthy();
    expect(nodesInstallCommandArgs({ repository: DEV_AUTHORS, channel: "  " }).conflict).toBeTruthy();
  });

  it("catches the name that is ambiguous INSIDE one channel, with no second channel", () => {
    // 28 names collapse two entries onto one key, where the survivor is list order.
    // `default` lists BOTH Zuellni/ComfyUI-Custom-Nodes and rcsaquino/comfyui-custom-nodes
    // (a case variant), so asking it for that name cannot be answered.
    const conflict =
      nodesInstallCommandArgs({ repository: "https://github.com/Zuellni/ComfyUI-Custom-Nodes" })
        .conflict ?? "";
    expect(conflict).toMatch(/carries that name TWICE/i);
    expect(conflict).toMatch(/Zuellni\/ComfyUI-Custom-Nodes/);
    expect(conflict).toMatch(/rcsaquino\/comfyui-custom-nodes/);
  });

  it("catches the EXACT-CASE duplicate too, which Manager drops before anyone sees it", () => {
    // Gate finding. `load_nightly` does `res[repo_name] = (x, False)` into a plain dict, so
    // two entries whose bare names match EXACTLY overwrite — one of them is gone before
    // `NormalizedKeyDict` is involved at all. The first shape of the generator modelled
    // that overwrite and so recorded only the survivor, which made the name look unique
    // and the guard never fire: `default` carries both 1038lab/ComfyUI-Pollinations and
    // ciga2011/ComfyUI-Pollinations, and asking for either one could get the other.
    const conflict =
      nodesInstallCommandArgs({ repository: "https://github.com/1038lab/ComfyUI-Pollinations" })
        .conflict ?? "";
    expect(conflict).toMatch(/carries that name TWICE/i);
    expect(conflict).toMatch(/1038lab\/ComfyUI-Pollinations/);
    expect(conflict).toMatch(/ciga2011\/ComfyUI-Pollinations/);
  });

  it("does NOT read an off-host URL as a match for the GitHub repo of the same path", () => {
    // Gate finding. `gitlab.com/0dot77/comfyui-annotations` is not
    // `github.com/0dot77/comfyui-annotations`; comparing only owner/repo made the first
    // one look like an exact match for `default`'s entry and waved it through, while v4
    // would still have resolved the bare name and cloned the GitHub one.
    const out = nodesInstallCommandArgs({
      repository: "https://gitlab.com/0dot77/comfyui-annotations",
    });
    expect(out.conflict).toBeTruthy();
    // And it quotes the URL they actually passed rather than inventing a github owner.
    expect(out.conflict).toMatch(/"https:\/\/gitlab\.com\/0dot77\/comfyui-annotations"/);
    expect(out.conflict).not.toMatch(/github\.com\/0dot77\/comfyui-annotations, and/);
    // The same path ON github is the channel's own entry, so that one still installs.
    expect(
      nodesInstallCommandArgs({ repository: "https://github.com/0dot77/comfyui-annotations" })
        .conflict,
    ).toBeUndefined();
  });

  it("names the Manager 3.x escape, where the URL IS cloned as passed", () => {
    // Gate finding, and it cannot be fixed by detection: the 3.x dialects send
    // `files:[url]` and clone it directly, so this refusal is a false positive there — but
    // the PANEL picks the dialect after the request leaves the orchestrator, and the
    // orchestrator's own dialect cache is keyed to a ComfyUI that need not be the panel's.
    // So it is disclosed with the one argument that clears it.
    const conflict = nodesInstallCommandArgs({ repository: DEV_AUTHORS }).conflict ?? "";
    expect(conflict).toMatch(/Manager 3\.x/);
    expect(conflict).toMatch(/IS cloned as passed/i);
  });

  it("does NOT offer the channel bypass as the remedy when no channel can deliver", () => {
    // GATE ROUND 2, and the worst kind of defect this PR could have shipped: the refusal
    // told EVERY caller that "naming any `channel` explicitly makes the choice yours and
    // bypasses it" — including the ones it had just told, one sentence earlier, that no
    // channel resolves the name to their repository. Following the last thing they read
    // (`channel:"default"`) dispatches and installs ciga2011's code as a success. That is
    // the exact install this guard exists to prevent, reached through the guard's own
    // advice. Measured: all 65 repositories trapped inside a multi-candidate channel have
    // NO uniquely-resolving channel, so the sentence was wrong for every one of them.
    const conflict =
      nodesInstallCommandArgs({ repository: "https://github.com/1038lab/ComfyUI-Pollinations" })
        .conflict ?? "";
    expect(conflict).toMatch(/No channel in the snapshot resolves/);
    expect(conflict).not.toMatch(/makes the choice yours/);
    expect(conflict).toMatch(/do not read that as the remedy here/i);
    // The bypass is still disclosed — it must stay reachable for Manager 3.x — but as the
    // 3.x escape it actually is, not as the way to get the repository they named.
    expect(conflict).toMatch(/Manager 3\.x/);
    expect(conflict).toMatch(/no way to aim/i);
  });

  it("KEEPS the plain bypass wording where a channel really does deliver", () => {
    // The cross-channel case is untouched: `dev` resolves the caller's repo, so naming it
    // both bypasses the check AND fetches what they asked for. Narrowing the sentence must
    // not have flattened this one into the same hedged text.
    const conflict = nodesInstallCommandArgs({ repository: DEV_AUTHORS }).conflict ?? "";
    expect(conflict).toMatch(/makes the choice yours and bypasses it/);
    expect(conflict).not.toMatch(/do not read that as the remedy here/i);
  });

  it("NO refusal ever recommends a bypass it has just ruled out", () => {
    // The report's own input, applied to all 111 names rather than the two hand-picked
    // above: a message that says "no channel resolves this" and "naming a channel makes
    // the choice yours" in the same breath is self-contradictory whichever name produced
    // it. Enumerate instead of trusting the two examples.
    for (const [name, byChannel] of Object.entries(AMBIGUOUS_BARE_NAMES)) {
      for (const channel of Object.keys(byChannel)) {
        for (const repo of byChannel[channel as keyof typeof byChannel] ?? []) {
          const amb = bareNameAmbiguity(`https://github.com/${repo}`, channel);
          if (!amb) continue;
          const text = ambiguousBareNameRefusal(amb);
          const deadEnd = /No channel in the snapshot resolves/.test(text);
          const promisesAChannel = /makes the choice yours/.test(text);
          expect(deadEnd && promisesAChannel, `${name} @ ${channel} -> ${repo}`).toBe(false);
        }
      }
    }
  });

  it("the NAMED-channel warning does not claim a choice the caller could not make", () => {
    // GATE ROUND 2. `default` carries ComfyUI-Pollinations twice, so `channel:"default"`
    // selected nothing — both entries are in the list they named and v4 falls back on
    // upstream list order. "Dispatched anyway because you chose the channel" invites them
    // to trust an install they never aimed.
    const out = nodesInstallCommandArgs({
      repository: "https://github.com/1038lab/ComfyUI-Pollinations",
      channel: "default",
    });
    expect(out.conflict).toBeUndefined(); // still dispatches — the escape must survive
    const note = out.note ?? "";
    expect(note).toMatch(/did NOT disambiguate this one/);
    expect(note).not.toMatch(/Dispatched anyway because you chose the channel/);
    expect(note).toMatch(/install_custom_node \(source:"git"\)/);
  });

  it("the cross-channel warning still credits the choice the caller DID make", () => {
    // `legacy` carries the name once, so naming it was a real selection between channels.
    const note = nodesInstallCommandArgs({ repository: DEV_AUTHORS, channel: "legacy" }).note ?? "";
    expect(note).toMatch(/Dispatched anyway because you chose the channel/);
    expect(note).not.toMatch(/did NOT disambiguate/);
  });

  it("matches the name CASE-INSENSITIVELY, the way Manager's own lookup does", () => {
    // `NormalizedKeyDict.get` keys on `key.strip().lower()`. A case-sensitive guard is
    // exactly what undercounted the hazard at 65 in the first place.
    for (const spelling of ["ComfyUI-BiRefNet", "comfyui-birefnet", "COMFYUI-BIREFNET"]) {
      const out = nodesInstallCommandArgs({
        repository: `https://github.com/mohammadaboulela/${spelling}`,
      });
      expect(out.conflict, spelling).toBeTruthy();
    }
  });

  it("compares the OWNER case-insensitively too — GitHub owners are", () => {
    // `dev` records the owner as `MohammadAboulEla`; the caller types it lowercase. A
    // case-sensitive owner comparison would refuse a caller who named exactly the repo
    // that channel carries.
    const out = nodesInstallCommandArgs({ repository: DEV_AUTHORS, channel: "dev" });
    expect(out.conflict).toBeUndefined();
    expect(out.channel).toBe("dev");
  });

  it("reaches every spelling the panel routes as git, not just an https URL", () => {
    // The routing predicate and the guard have to agree or a shorthand slips past — the
    // #1539 gate-round-3 defect in a new place. `author/repo` is the form this tool's own
    // description tells callers to pass.
    for (const spelling of [
      "mohammadaboulela/ComfyUI-BiRefNet",
      "https://github.com/mohammadaboulela/ComfyUI-BiRefNet.git",
      "git@github.com:mohammadaboulela/ComfyUI-BiRefNet.git",
      "ssh://git@github.com/mohammadaboulela/ComfyUI-BiRefNet",
      "git://github.com/mohammadaboulela/ComfyUI-BiRefNet",
    ]) {
      expect(nodesInstallCommandArgs({ id: spelling }).conflict, spelling).toBeTruthy();
      expect(nodesInstallCommandArgs({ repository: spelling }).conflict, spelling).toBeTruthy();
    }
  });

  it("MUST NOT touch a name the snapshot has not seen collide", () => {
    // 111 names out of ~5850 in `default` alone. Everything else keeps what it had.
    expect(nodesInstallCommandArgs({ repository: UNCOLLIDING }).conflict).toBeUndefined();
    expect(nodesInstallCommandArgs({ repository: UNCOLLIDING }).channel).toBe("default");
  });

  it("MUST NOT touch the registry-id route, which never resolves by bare name", () => {
    // A slash-free registry id goes to the CNR path, where the id IS the identifier —
    // even when it spells a name that collides on the from-source route.
    const out = nodesInstallCommandArgs({ id: "comfyui-birefnet", version: "latest" });
    expect(out.conflict).toBeUndefined();
    expect(out.id).toBe("comfyui-birefnet");
    expect(nodesInstallCommandArgs({ id: "comfyui-kjnodes" }).conflict).toBeUndefined();
  });

  it("the id+repository conflict still wins — it is checked first", () => {
    const out = nodesInstallCommandArgs({ id: "comfyui-kjnodes", repository: DEV_AUTHORS });
    expect(out.conflict).toMatch(/BOTH id .* and repository/);
  });

  it("REFUSES ON THE WIRE — nothing is dispatched, and the caller is told why", async () => {
    const out = await attemptInstall({ repository: DEV_AUTHORS });
    expect(out.isError).toBe(true);
    expect(out.sent).toBeUndefined();
    expect(out.text).toMatch(/REFUSED before dispatch/i);
    expect(out.text).toMatch(/hieuck\/ComfyUI-BiRefNet/);
  });

  it("STILL DISPATCHES the allowed one, so the guard is not a blanket block", async () => {
    const out = await attemptInstall({ repository: DEFAULT_AUTHORS });
    expect(out.isError).toBe(false);
    expect(out.sent?.cmd).toBe("nodes_install");
    expect(out.sent?.channel).toBe("default");
  });

  it("the tool's DESCRIPTION says the refusal exists, before any call is made", () => {
    const text = installNodeDef().description ?? "";
    expect(text).toMatch(/REFUSES instead of picking/i);
    expect(text).toMatch(/111 bare names/);
    expect(text).toMatch(/28 are ambiguous inside ONE channel/i);
    // And the 3.x false positive is disclosed where a caller reads before calling.
    expect(text).toMatch(/Manager 3\.x/);
  });
});

describe("the snapshot and its predicate (#1616)", () => {
  it("every listed name really is ambiguous — no entry that agrees with itself", () => {
    // A name whose channels all point at one repository can only produce false refusals.
    for (const [name, byChannel] of Object.entries(AMBIGUOUS_BARE_NAMES)) {
      const repos = new Set(
        Object.values(byChannel)
          .flat()
          .map((r) => r.toLowerCase()),
      );
      expect(repos.size, name).toBeGreaterThan(1);
    }
  });

  it("every key is already lowercased, since the lookup lowercases", () => {
    for (const name of Object.keys(AMBIGUOUS_BARE_NAMES)) {
      expect(name, name).toBe(name.toLowerCase());
    }
  });

  it("every candidate parses as owner/repo, so the refusal can name it", () => {
    for (const [name, byChannel] of Object.entries(AMBIGUOUS_BARE_NAMES)) {
      for (const repo of Object.values(byChannel).flat()) {
        expect(repo, `${name} -> ${repo}`).toMatch(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
      }
    }
  });

  it("holds the measured population — 111 names, 28 ambiguous within one channel", () => {
    // Pinned so a regeneration that silently drops the table (an empty object still
    // passes every "for each entry" assertion above) is caught.
    const names = Object.keys(AMBIGUOUS_BARE_NAMES);
    expect(names.length).toBe(111);
    const intra = names.filter((n) =>
      Object.values(AMBIGUOUS_BARE_NAMES[n]).some((repos) => repos.length > 1),
    );
    expect(intra.length).toBe(28);
  });

  it("records EVERY repository under a name, not the one list order would pick", () => {
    // The generator must not model Manager's overwrite. If it does, the loser vanishes and
    // an exact-case duplicate reads as a unique name — the guard then never fires for it.
    expect(AMBIGUOUS_BARE_NAMES["comfyui-pollinations"]?.default).toEqual([
      "1038lab/ComfyUI-Pollinations",
      "ciga2011/ComfyUI-Pollinations",
    ]);
  });

  it("reads the host, so an off-host URL is never a match", () => {
    expect(gitHostOf("https://gitlab.com/a/b")).toBe("gitlab.com");
    expect(gitHostOf("git@gitlab.com:a/b.git")).toBe("gitlab.com");
    expect(gitHostOf("ssh://git@github.com/a/b")).toBe("github.com");
    expect(gitHostOf("https://GitHub.com/a/b")).toBe("github.com");
    // A bare shorthand names no host; the panel expands it to github.com.
    expect(gitHostOf("a/b")).toBeUndefined();
  });

  it("derives the bare name exactly as the panel's gitRepoName does", () => {
    // That is the string the panel puts in `id`, and therefore the string Manager looks
    // up. Deriving it any other way here checks a name that never gets sent.
    expect(managerBareName("https://github.com/a/Repo-Name.git")).toBe("Repo-Name");
    expect(managerBareName("git@github.com:a/Repo-Name.git")).toBe("Repo-Name");
    expect(managerBareName("https://github.com/a/Repo-Name/")).toBe("Repo-Name");
    expect(managerBareName("https://github.com/a/Repo-Name?x=1#y")).toBe("Repo-Name");
    expect(managerBareName("a/Repo-Name")).toBe("Repo-Name");
  });

  it("parses owner/repo from every spelling the bare name comes from", () => {
    expect(ownerRepoOf("https://github.com/Own-er/Repo.git")).toBe("Own-er/Repo");
    expect(ownerRepoOf("git@github.com:Own-er/Repo.git")).toBe("Own-er/Repo");
    expect(ownerRepoOf("ssh://git@github.com/Own-er/Repo")).toBe("Own-er/Repo");
    expect(ownerRepoOf("Own-er/Repo")).toBe("Own-er/Repo");
  });

  it("says nothing about a channel that does not list the name at all", () => {
    // `comfyui-birefnet` is on default/dev/legacy. `forked` does not carry it, so asking
    // `forked` resolves nothing and there is no substitution to refuse.
    expect(bareNameAmbiguity(DEV_AUTHORS, "forked")).toBeUndefined();
    expect(bareNameAmbiguity(DEV_AUTHORS, "legacy")).toBeTruthy();
  });

  it("tolerates a channel name it has never heard of rather than throwing", () => {
    // A caller can pass any string; Manager validates it, this must not crash first.
    expect(bareNameAmbiguity(DEV_AUTHORS, "not-a-channel")).toBeUndefined();
    expect(nodesInstallCommandArgs({ repository: DEV_AUTHORS, channel: "not-a-channel" }).conflict)
      .toBeUndefined();
  });

  it("treats an INHERITED key as a channel it has never heard of, not as a hit", () => {
    // GATE ROUND 3. The test above passed while three specific strings still threw,
    // because both lookups indexed object literals with `obj[key]` — and an object
    // literal ANSWERS for what it inherits from Object.prototype. Measured before the
    // fix, on `repository:".../ComfyUI-BiRefNet"`:
    //
    //   channel:"__proto__"    -> TypeError: repos.map is not a function
    //   channel:"constructor"  -> TypeError: Cannot read properties of undefined
    //
    // `__proto__` hands back Object.prototype, whose `.length` is undefined, so neither
    // the falsy check nor `length === 0` stops it and it rides into listRepos.
    // `constructor` is worse: Object.length is 1, so it passes the `length === 1` branch
    // and reaches sameRepo(undefined, …). Not a trust boundary — one machine — just a
    // name no table contains being read as a hit, which turns the tool into a throw
    // instead of the answer the case above promises.
    for (const inherited of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect(bareNameAmbiguity(DEV_AUTHORS, inherited), inherited).toBeUndefined();
      expect(
        nodesInstallCommandArgs({ repository: DEV_AUTHORS, channel: inherited }).conflict,
        inherited,
      ).toBeUndefined();
    }
  });

  it("treats an inherited BARE NAME the same way — though nothing today depends on it", () => {
    // HONEST SCOPE: unlike the case above, this one passes with OR without the
    // own-property guard, so it is not what proves that guard. It cannot currently
    // reach the throw: an inherited bare name makes `entry` Object.prototype (or the
    // Object constructor), and the CHANNEL lookup that runs next asks it for "default",
    // gets undefined, and returns at the `!channelCandidates` check. The guard is
    // applied at the name lookup anyway because being saved by the next statement is
    // not the same as being correct, and this test pins the outcome so a reorder of
    // those two lookups cannot quietly turn a repo named `constructor` into a throw.
    for (const inherited of ["__proto__", "constructor", "toString"]) {
      expect(bareNameAmbiguity(`https://github.com/someone/${inherited}`, "default"), inherited)
        .toBeUndefined();
    }
  });

  it("refuses a URL it cannot parse an owner out of, rather than assuming a match", () => {
    // No owner means no way to tell the caller's repo from the channel's, and the
    // fallback position is to name both rather than to guess.
    const amb = bareNameAmbiguity("https://github.com/ComfyUI-BiRefNet", "default");
    expect(amb).toBeTruthy();
    expect(amb?.callerRepo).toBeUndefined();
  });
});
