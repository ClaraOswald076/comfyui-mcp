/**
 * Is this commit subject a RELEASE, rather than something a release contains?
 * (#1309)
 *
 * Three shapes, and the third is the one this repo produces on EVERY release —
 * `npm version patch -m "chore(release): %s"`, squash-merged with the PR number
 * appended by GitHub:
 *
 *   release: v0.50.87 — …            a hand-written release PR
 *   0.50.85 (#1302)                  a bare version subject
 *   chore(release): 0.50.85 (#1302)  what the release flow actually writes
 *
 * Only the first two were matched, so every release-reconcile commit fell
 * through to the conventional-commit parser, was read as a `chore` with scope
 * `release`, and appeared in the NEXT release's entry under "Changed".
 *
 * Nothing else caught it: the de-duplication that makes the deliberately-wide
 * commit range safe is "filter out PRs the changelog already documents", and a
 * release-reconcile PR is never documented — it is not a change.
 *
 * Deliberately NOT a blanket `chore:` skip. An ordinary chore can be a real
 * user-facing change, and dropping those silently is the failure this generator
 * already warns about at length. Only the `release` SCOPE is a release.
 *
 * Lives in its own module so it can be tested directly. An earlier attempt tested
 * it through the generator against a scratch repo and the test passed with the fix
 * REVERTED — the synthetic history dropped the entry for an unrelated reason, so
 * it was verifying nothing.
 */
export const isReleaseSubject = (s) =>
  /^release:/i.test(s) ||
  /^v?\d+\.\d+\.\d+\s*(\(#\d+\))?$/.test(s) ||
  /^\w+\(release\)!?:/i.test(s);
