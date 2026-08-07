// #945 — `git pull` exiting 0 is not evidence that anything moved.
//
// On a DETACHED HEAD — how Comfy Desktop's release-tag installs sit — `git pull`
// prints "Already up to date." and exits 0 while moving nothing. The same happens
// when `remote.origin.fetch` carries only a tag refspec, so `origin/master` is
// never fetched and stays stale or absent.
//
// Both were reported as `updated: true`, and the Python requirements were then
// reinstalled for a checkout that had not moved — which is what made the false
// success convincing: it looked like work. The reporter's install stayed pinned
// at v0.30.2 (dec5d945) while master had advanced to 2eb60976, and the tool said
// it had updated.
//
// The rule under test: a sha that CHANGED proves an update. A sha that did not
// change proves nothing on its own — it is "already current" only if it can be
// shown equal to the upstream tip. Everything else reports NOT updated, with the
// reason.

import { describe, expect, it } from "vitest";
import { classifyCoreUpdate } from "../../services/update-comfyui.js";

const TAG_SHA = "dec5d9451111111111111111111111111111111a";
const MASTER_SHA = "2eb607962222222222222222222222222222222b";

describe("#945: a changed sha is the only self-sufficient proof", () => {
  it("reports updated when HEAD moved", () => {
    const v = classifyCoreUpdate({
      before: TAG_SHA,
      after: MASTER_SHA,
      branch: "master",
      upstream: "origin/master",
      upstreamSha: MASTER_SHA,
    });
    expect(v.updated).toBe(true);
    expect(v.blocker).toBeUndefined();
  });

  // A moved sha needs no corroboration — not even a readable upstream.
  it("reports updated when HEAD moved even with nothing else knowable", () => {
    expect(
      classifyCoreUpdate({
        before: TAG_SHA,
        after: MASTER_SHA,
        branch: null,
        upstream: null,
        upstreamSha: null,
      }).updated,
    ).toBe(true);
  });
});

describe("#945: an unmoved sha is not a success", () => {
  // THE reported case.
  it("a detached HEAD is reported as NOT updated, with the reason and the remedy", () => {
    const v = classifyCoreUpdate({
      before: TAG_SHA,
      after: TAG_SHA,
      branch: null,
      upstream: null,
      upstreamSha: null,
    });
    expect(v.updated).toBe(false);
    expect(v.blocker?.reason).toBe("detached");
    expect(v.blocker?.message).toMatch(/DETACHED/);
    expect(v.blocker?.message).toMatch(/Already up to date/);
    expect(v.blocker?.message).toMatch(/git checkout master/);
    // It must NOT offer to move the user's HEAD for them — a detached checkout
    // may carry local edits, and switching branches is theirs to decide.
    expect(v.blocker?.message).toMatch(/will not move your HEAD/);
  });

  it("a branch with no upstream is reported as NOT updated", () => {
    const v = classifyCoreUpdate({
      before: TAG_SHA,
      after: TAG_SHA,
      branch: "master",
      upstream: null,
      upstreamSha: null,
    });
    expect(v.updated).toBe(false);
    expect(v.blocker?.reason).toBe("no-upstream");
    expect(v.blocker?.message).toMatch(/--set-upstream-to=origin\/master/);
  });

  // The tag-only refspec: an upstream is configured but was never fetched, so
  // its ref does not resolve. "I could not check" must not become "it is fine".
  it("an unresolvable upstream is UNVERIFIABLE, not current", () => {
    const v = classifyCoreUpdate({
      before: TAG_SHA,
      after: TAG_SHA,
      branch: "master",
      upstream: "origin/master",
      upstreamSha: null,
    });
    expect(v.updated).toBe(false);
    expect(v.blocker?.reason).toBe("unverifiable");
    expect(v.matchesUpstream).toBeNull(); // null ≠ false: we did not check
    expect(v.blocker?.message).toMatch(/only a tag refspec/);
    expect(v.blocker?.message).toMatch(/remote\.origin\.fetch/);
    expect(v.blocker?.message).toMatch(/\+refs\/heads\/master:refs\/remotes\/origin\/master/);
  });

  it("a resolvable upstream that is AHEAD is reported as not updated, with both shas", () => {
    const v = classifyCoreUpdate({
      before: TAG_SHA,
      after: TAG_SHA,
      branch: "master",
      upstream: "origin/master",
      upstreamSha: MASTER_SHA,
    });
    expect(v.updated).toBe(false);
    expect(v.blocker?.reason).toBe("behind-upstream");
    expect(v.matchesUpstream).toBe(false);
    expect(v.blocker?.message).toContain("dec5d945");
    expect(v.blocker?.message).toContain("2eb60796");
    expect(v.blocker?.message).toMatch(/merge --ff-only origin\/master/);
  });

  it("an unreadable revision is UNKNOWN, never a success", () => {
    const v = classifyCoreUpdate({
      before: null,
      after: null,
      branch: null,
      upstream: null,
      upstreamSha: null,
    });
    expect(v.updated).toBe(false);
    expect(v.blocker?.reason).toBe("unverifiable");
    expect(v.blocker?.message).toMatch(/UNKNOWN/);
  });
});

describe("#945: the one honest 'nothing to do'", () => {
  it("HEAD proven equal to the upstream tip IS a success", () => {
    const v = classifyCoreUpdate({
      before: MASTER_SHA,
      after: MASTER_SHA,
      branch: "master",
      upstream: "origin/master",
      upstreamSha: MASTER_SHA,
    });
    expect(v.updated).toBe(true);
    expect(v.matchesUpstream).toBe(true);
    expect(v.blocker).toBeUndefined();
  });

  // The distinction that was missing: "already current" is only claimable when
  // the upstream was actually READ. Without that read it is the detached/
  // tag-refspec case, and those must not share this verdict.
  it("is not reachable without a resolved upstream sha", () => {
    for (const upstreamSha of [null, ""]) {
      expect(
        classifyCoreUpdate({
          before: MASTER_SHA,
          after: MASTER_SHA,
          branch: "master",
          upstream: "origin/master",
          upstreamSha: upstreamSha as string | null,
        }).updated,
      ).toBe(false);
    }
  });
});
