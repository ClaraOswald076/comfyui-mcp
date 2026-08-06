// Suite-wide home-directory isolation (#879, #866). Registered as a vitest
// `setupFiles` entry, so it runs in every worker BEFORE any test file — and
// therefore before any product module — is imported.
//
// Four times now the full suite has rewritten the developer's real
// ~/.comfyui-mcp state (#837 the .env, #859 the OAuth mirror, #866 the
// pending-ops marker, #879 the .env again through a path no guard covered).
// Each prior fix scoped one store behind one env var, and each eroded: the
// next test forgot the one line, or set it in a way Node quietly emptied
// (`"\0"` truncates to `""`), or wrote from a scope the per-store guard could
// not see. #879's writer was never found precisely because it ran OUTSIDE the
// worker scopes the runtime guards observe — a module-eval side effect during
// collection, or a spawned child that inherited an unredirected environment.
//
// This file fixes the property instead of the instance: for the whole run,
// the home directory IS a fresh temp directory. Every homedir()-based default
// — including module-eval-time captures and children that inherit env — lands
// in the throwaway home, for writers nobody has audited yet. The real home is
// recorded first, so test-isolation-guard.ts can still REFUSE a write that is
// deliberately pointed back at it.
//
// Per-worker, not per-run: workers run in parallel and must not share a home
// (two workers' writes to the same default path would race exactly like the
// real-home writes did). The temp homes are left for the OS to reap — every
// test in this suite already leaves its mkdtemp fixtures the same way.

import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  realHomeRecordedForTestIsolation,
  recordRealHomeForTestIsolation,
} from "../../services/test-isolation-guard.js";

// Record the real home ONCE per worker process. setupFiles re-run for EVERY
// test file a reused worker executes, and by the second run HOME already
// points at the throwaway home created for the first file — an unconditional
// record would overwrite the real home with a temp one, and the write-guards
// would then compare against the wrong directory (codex gate, round 1).
if (realHomeRecordedForTestIsolation() === undefined) {
  recordRealHomeForTestIsolation(homedir());
}

const isolatedHome = mkdtempSync(join(tmpdir(), "comfyui-mcp-test-home-"));

// Node's os.homedir() consults HOME on POSIX and USERPROFILE on Windows, at
// call time, so this covers both static and dynamic home resolution — as long
// as it runs before the first product module is imported, which the
// `setupFiles` ordering guarantees.
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
