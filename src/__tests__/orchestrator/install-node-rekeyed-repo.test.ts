// #1624 — A REPOSITORY THAT CANNOT BE INSTALLED BY ITS OWN NAME IS REFUSED, NOT SWAPPED.
//
// #1619 refuses the from-source install when the BARE NAME is contested across the six
// channel lists. This is the same substitution reached without any contest, and the
// mechanism is re-read at ComfyUI-Manager 4.2.2's own source
// (comfyui_manager/glob/manager_core.py at tag 4.2.2 — NOT `main`, which is the 3.41
// line and has no CNR fallback at all):
//
//   get_custom_nodes  cnr = self.get_cnr_by_repo(v['files'][0])
//                     if cnr: v['id'] = cnr['id']; node_id = v['id']
//                     else:   node_id = v['files'][0].split('/')[-1]
//   install_by_id     the_node = custom_nodes.get(node_id)          # NormalizedKeyDict
//                     if the_node is None and version_spec == 'nightly':
//                         cnr_fallback = self.cnr_map.get(node_id)
//                         repo_url = cnr_fallback['repository']     # someone ELSE's repo
//
// So a repository registered under an id that is not its own bare name is filed under
// that id, and a lookup for its name cannot return it from ANY channel. What answers
// instead is another channel entry that was not re-keyed, or the registry pack whose id
// IS that name. Either way the caller gets code they did not ask for, reported as a
// success.
//
// ## What was measured, replaying that resolution over the six channel lists plus the
// ## whole Comfy Registry (5117 repositories)
//
//   * 1366 repositories are re-keyed;
//   * 1268 of those resolve to NOTHING — Manager answers "not found", installs nobody's
//     code, and they are deliberately NOT recorded, because turning a clean failure into
//     a refusal is not this bug;
//   * 98 resolve to a DIFFERENT repository, 84 of them on the channel this code defaults
//     to. 56 are invisible to #1619's contested-name table, which is the gap this closes.
//
// ## What this deliberately does not cover
//
// The table is keyed by the CALLER'S repository, so it fires only for repositories the
// registry knows. An unregistered, unlisted fork named `ComfyUI-GGUF` hits exactly the
// same substitution and is not in here — that set is not enumerable from any snapshot.
// Those keep today's behaviour and the standing dispatch note.
import { describe, expect, it, vi } from "vitest";
import { nodesInstallCommandArgs } from "../../services/node-management.js";
import {
  AMBIGUOUS_BARE_NAMES,
  bareNameAmbiguity,
  REKEYED_REPOS,
  REKEYED_SUBSTITUTIONS,
  rekeyedRegistryVersionAmbiguity,
  rekeyedRepoAmbiguity,
  rekeyedRepoRefusal,
} from "../../services/manager-bare-name-collisions.js";

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

// A CHANNEL-route case: Mattabyte's fork is registered as "ComfyUI-GGUF_Forked", so the
// name "ComfyUI-GGUF" is filed under city96's entry and `default` answers with city96.
const FORK_CHANNEL = "https://github.com/Mattabyte/ComfyUI-GGUF";
const FORK_CHANNEL_LANDS = "city96/ComfyUI-GGUF";
// A CNR-FALLBACK case: hekmon's repo is registered as "openai-api", nothing in `default`
// answers to "comfyui-openai-api", so the nightly fallback clones the registry's pack.
const FALLBACK = "https://github.com/hekmon/comfyui-openai-api";
const FALLBACK_LANDS = "bgreene2/ComfyUI-OpenAI-API";
// The counterpart that MUST still dispatch: city96's own repo is registered under its own
// name, so the lookup reaches it and there is nothing to refuse.
const UPSTREAM = "https://github.com/city96/ComfyUI-GGUF";

describe("#1624 — a re-keyed repository is refused instead of substituted", () => {
  it("refuses the defaulted-channel install and NAMES what would land instead", () => {
    // THE CALL-SITE TEST. `rekeyedRepoAmbiguity` returning the right object proves
    // nothing about production: the whole fix on this path is one `if` in
    // `nodesInstallCommandArgs`, and a helper-level assertion survives deleting it.
    const res = nodesInstallCommandArgs({ repository: FORK_CHANNEL });
    expect(res.conflict).toBeTruthy();
    expect(res.conflict).toContain(FORK_CHANNEL_LANDS);
    // The reason has to be the real one — the id it is filed under, quoted.
    expect(res.conflict).toContain("ComfyUI-GGUF_Forked");
    // ...and it must not dispatch anything while refusing.
    expect(res.id).toBeUndefined();
    expect(res.repository).toBeUndefined();
  });

  it("refuses the CNR-fallback case and says the registry, not a channel, decides it", () => {
    const res = nodesInstallCommandArgs({ repository: FALLBACK });
    expect(res.conflict).toBeTruthy();
    expect(res.conflict).toContain(FALLBACK_LANDS);
    expect(res.conflict).toContain("cnr_map");
    // Claiming a channel's list carries the name when it carries nothing would be a
    // fabricated mechanism — the same failure #1619's gate round 6 caught.
    expect(res.conflict).not.toContain("channel's list DOES answer");
  });

  it("still dispatches the repository the name actually resolves to", () => {
    // The fix must not degrade into "refuse anything that looks like a fork". city96's
    // repo is registered as `comfyui-gguf`, so `get_custom_nodes` files it under its own
    // name and the install is correct. This is the assertion that fails if the table is
    // keyed by bare NAME instead of by the caller's repository.
    expect(REKEYED_SUBSTITUTIONS["city96/comfyui-gguf"]).toBeUndefined();
    const res = nodesInstallCommandArgs({ repository: UPSTREAM });
    expect(res.conflict).toBeUndefined();
    expect(res.repository).toBe(UPSTREAM);
  });

  it("dispatches when the caller named a channel, but says the choice aimed nothing", () => {
    // Same escape as #1619: a named channel is the caller's own choice and the one way
    // past a stale snapshot, and on Manager 3.x the URL passed IS what gets cloned. What
    // it must NOT do is repeat the "you chose the channel" framing — no channel argument
    // can reach a repository filed under an id that is not its name.
    const res = nodesInstallCommandArgs({ repository: FORK_CHANNEL, channel: "default" });
    expect(res.conflict).toBeUndefined();
    expect(res.repository).toBe(FORK_CHANNEL);
    expect(res.note).toContain("RE-KEYED PACK");
    expect(res.note).toContain(FORK_CHANNEL_LANDS);
    expect(res.note).toContain('install_custom_node (source:"git")');
  });

  it("refuses the registry-version route too, and does not offer dropping `version`", () => {
    // An explicit version skips `get_custom_nodes` entirely and installs the registry
    // pack whose id is the bare name — city96's. Unlike #1619's registry-version refusal,
    // dropping `version` is NOT the remedy here: the from-source route resolves the same
    // name and cannot reach this repository either.
    const res = nodesInstallCommandArgs({ repository: FORK_CHANNEL, version: "1.2.3" });
    expect(res.conflict).toBeTruthy();
    expect(res.conflict).toContain(FORK_CHANNEL_LANDS);
    expect(res.conflict).toContain("does NOT rescue this one");
    expect(res.conflict).toContain('install_custom_node (source:"git")');
  });

  it("does not apply channel reasoning to a route Manager reads no channel for", () => {
    // GATE FINDING. GuardSkill/ComfyUI-ElevenLabs is re-keyed ("ElevenLabs") and `default`
    // answers to its name with jerilseb's — but the registry holds no pack called
    // `comfyui-elevenlabs`, so `rekeyedRegistryVersionAmbiguity` declines and the call
    // used to fall through to the FROM-SOURCE refusal, which told the caller the default
    // channel's list was what would be cloned. With an explicit version Manager never
    // reads a channel: it calls `cnr_install("ComfyUI-ElevenLabs", "1.2.3")`, finds no
    // such id, and fails. Refusing was directionally right and the remedy was correct,
    // which is precisely how a fabricated mechanism survives — so the call dispatches and
    // takes Manager's own "not found" instead. 12 of the 98 records are in this shape.
    const url = "https://github.com/GuardSkill/ComfyUI-ElevenLabs";
    const rec = REKEYED_SUBSTITUTIONS["guardskill/comfyui-elevenlabs"];
    expect(rec?.channelTargets.default ?? []).toHaveLength(1);
    expect(rec?.registryTarget).toBeUndefined();
    const res = nodesInstallCommandArgs({ repository: url, version: "1.2.3" });
    expect(res.conflict).toBeUndefined();
    expect(res.note ?? "").not.toContain("RE-KEYED PACK");
    // The same URL with no version IS on the from-source route, and is still refused.
    expect(nodesInstallCommandArgs({ repository: url }).conflict).toContain(
      "jerilseb/ComfyUI-ElevenLabs",
    );
  });

  it("does not treat a from-source spec as a registry version", () => {
    // "nightly" and "unknown" DO consult the channel, so they belong to the from-source
    // refusal — routing them to the registry-version message would state a mechanism that
    // is not the one running.
    for (const spec of ["nightly", "unknown", "NIGHTLY", " nightly "]) {
      expect(rekeyedRegistryVersionAmbiguity(FORK_CHANNEL, spec), spec).toBeUndefined();
    }
    expect(rekeyedRegistryVersionAmbiguity(FORK_CHANNEL, "1.2.3")).toBeTruthy();
  });

  it("leaves the contested-name refusal in charge where BOTH tables know the repo", () => {
    // wildminder/ComfyUI-Chatterbox is in both tables — #1619's because
    // `comfyui-chatterbox` is contested, this one's because the repo is re-keyed. Only
    // one refusal may be produced, and it must be the one that already reasons about
    // re-keying for that name, or the caller reads the same finding twice in two voices.
    expect(REKEYED_SUBSTITUTIONS["wildminder/comfyui-chatterbox"]).toBeTruthy();
    const res = nodesInstallCommandArgs({
      repository: "https://github.com/wildminder/ComfyUI-Chatterbox",
    });
    expect(res.conflict).toBeTruthy();
    expect(res.conflict).toContain("sm079/comfyui-chatterbox");
    expect(res.conflict).toContain("registered in the Comfy Registry under a different id");
    expect(res.conflict).not.toContain("RE-KEYED PACK");
  });

  it("says it ONCE on the named-channel path too, where neither message returns early", () => {
    // The refusal path above returns at the first conflict, so the ordering guard costs
    // nothing there and a mutation that drops it survives. The WARNING path is where it
    // is load-bearing: both messages ride the same `note`, so without the guard a caller
    // who named a channel reads the same finding twice, in two voices, with two different
    // remedies. Measured with the guard removed: the note carries both.
    const res = nodesInstallCommandArgs({
      repository: "https://github.com/wildminder/ComfyUI-Chatterbox",
      channel: "default",
    });
    expect(res.conflict).toBeUndefined();
    expect(res.note).toContain("NAMED-CHANNEL COLLISION");
    expect(res.note).not.toContain("RE-KEYED PACK");
  });

  it("does not refuse a re-keyed repo whose name resolves to nothing on the asked channel", () => {
    // RUFFY-369/ComfyUI-StreamDiffusion is re-keyed ("streamdiffusion") and `dev` answers
    // to its name — but `default` answers with nothing and the registry holds no pack of
    // that name, so Manager returns "not found". That installs nobody's code. Refusing it
    // would turn a clean failure into a refusal and widen this fix past what it measured;
    // this is the assertion that fails if the not-found branch is dropped.
    const url = "https://github.com/RUFFY-369/ComfyUI-StreamDiffusion";
    expect(REKEYED_SUBSTITUTIONS["ruffy-369/comfyui-streamdiffusion"]).toBeTruthy();
    expect(REKEYED_SUBSTITUTIONS["ruffy-369/comfyui-streamdiffusion"]?.registryTarget)
      .toBeUndefined();
    expect(rekeyedRepoAmbiguity(url, "default")).toBeUndefined();
    expect(nodesInstallCommandArgs({ repository: url }).conflict).toBeUndefined();
    // ...and on the channel that DOES answer, it is refused.
    expect(rekeyedRepoAmbiguity(url, "dev")?.resolvedVia).toBe("channel");
  });

  it("independently agrees with #1619's table on the reproduction #1624 was filed with", () => {
    // The two tables are computed by separate passes over the same registry fetch. If
    // they ever disagreed about the same repository, one of them would be wrong and
    // nothing else in the suite would notice.
    const rec = REKEYED_SUBSTITUTIONS["wildminder/comfyui-chatterbox"];
    expect(rec?.registryTarget).toBe("sm079/comfyui-chatterbox");
    expect(REKEYED_REPOS["comfyui-chatterbox"] ?? []).toContain("wildminder/ComfyUI-Chatterbox");
    // The shipped guard reaches the same landing for the same call.
    expect(bareNameAmbiguity("https://github.com/wildminder/ComfyUI-Chatterbox", "default")
      ?.registryTarget).toBe("sm079/comfyui-chatterbox");
  });

  it("does not match an `owner/repo` that came off another host", () => {
    // The snapshot holds github repositories only. A gitlab URL that merely shares the
    // path is a DIFFERENT repository, and refusing it would quote back a github repo the
    // caller never named — the same reasoning `comparableToSnapshot` already encodes.
    expect(rekeyedRepoAmbiguity("https://gitlab.com/Mattabyte/ComfyUI-GGUF", "default"))
      .toBeUndefined();
    expect(rekeyedRegistryVersionAmbiguity("https://gitlab.com/Mattabyte/ComfyUI-GGUF", "1.0.0"))
      .toBeUndefined();
  });

  it("matches the caller's repository however they cased it", () => {
    // Manager's case-sensitivity applies to the CHANNEL entry's URL against the registry,
    // not to what the caller typed. Someone who types the repo in the wrong case names
    // the same repository and is exposed to exactly the same substitution.
    expect(rekeyedRepoAmbiguity("https://github.com/MATTABYTE/comfyui-gguf", "default"))
      .toBeTruthy();
    expect(rekeyedRepoAmbiguity(`${FORK_CHANNEL}.git`, "default")).toBeTruthy();
  });

  it("tolerates channel names Manager would reject, and inherited keys, without throwing", () => {
    // `normalize_channel` raises InvalidChannel before any list is read, so there is no
    // substitution to warn about — and an object literal ANSWERS for `__proto__` and
    // `constructor`, which is how the same shape threw in #1619's gate round 3.
    expect(rekeyedRepoAmbiguity(FORK_CHANNEL, "not-a-channel")).toBeUndefined();
    for (const inherited of ["__proto__", "constructor", "toString", "valueOf"]) {
      expect(rekeyedRepoAmbiguity(FORK_CHANNEL, inherited), inherited).toBeUndefined();
      expect(
        rekeyedRepoAmbiguity(`https://github.com/someone/${inherited}`, "default"),
        inherited,
      ).toBeUndefined();
      expect(
        nodesInstallCommandArgs({ repository: FORK_CHANNEL, channel: inherited }).conflict,
        inherited,
      ).toBeUndefined();
    }
  });

  it("never names the caller's own repository as the substitute", () => {
    // A record saying "you asked for X and would get X" would be nonsense, and a refusal
    // built on it would be unanswerable. By construction it cannot happen — a re-keyed
    // repo is filed under its id, not its name — but the table is generated, so pin it.
    for (const [key, rec] of Object.entries(REKEYED_SUBSTITUTIONS)) {
      expect(key, `${key} must be the lowercased repo`).toBe(rec.repo.toLowerCase());
      const targets = [...Object.values(rec.channelTargets).flat()];
      if (rec.registryTarget) targets.push(rec.registryTarget);
      expect(targets.length, `${key} records no substitute at all`).toBeGreaterThan(0);
      for (const t of targets) {
        expect(t.toLowerCase(), `${key} lists itself as the substitute`).not.toBe(key);
      }
      expect(rec.id.trim().toLowerCase(), `${key} is not actually re-keyed`).not.toBe(
        rec.repo.split("/")[1].trim().toLowerCase(),
      );
    }
  });

  it("agrees with #1619's re-keyed table wherever both cover the same channel entry", () => {
    // REKEYED_REPOS records the same property for the CANDIDATES of a contested name. A
    // repository in both tables must be marked re-keyed in both, or one pass read the
    // registry differently from the other.
    for (const [key, rec] of Object.entries(REKEYED_SUBSTITUTIONS)) {
      const name = rec.repo.split("/")[1].trim().toLowerCase();
      const per = AMBIGUOUS_BARE_NAMES[name] as Record<string, string[]> | undefined;
      if (!per) continue;
      const listed = Object.values(per).flat();
      if (!listed.includes(rec.repo)) continue; // registry-only, nothing to cross-check
      expect(REKEYED_REPOS[name] ?? [], `${key} is re-keyed here but not in REKEYED_REPOS`)
        .toContain(rec.repo);
    }
  });

  it("states the mechanism it is actually running, on both routes", () => {
    // The refusal text is the only thing a caller acts on, so the branch that produced it
    // has to be the branch described. A channel-route refusal must not claim the registry
    // fallback fired, and vice versa.
    const chan = rekeyedRepoAmbiguity(FORK_CHANNEL, "default");
    expect(chan?.resolvedVia).toBe("channel");
    expect(rekeyedRepoRefusal(chan!)).toContain("channel's list DOES answer");

    const fall = rekeyedRepoAmbiguity(FALLBACK, "default");
    expect(fall?.resolvedVia).toBe("cnr-fallback");
    const text = rekeyedRepoRefusal(fall!);
    expect(text).toContain("falls back to the registry map");
    expect(text).not.toContain("channel's list DOES answer");
  });
});
