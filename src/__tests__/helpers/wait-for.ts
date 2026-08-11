import { vi } from "vitest";

/**
 * `vi.waitFor` with a deadline that is not the thing under test (#1325).
 *
 * ## The defect
 *
 * `vi.waitFor`'s default timeout is ONE SECOND, and `testTimeout` does not govern it — it
 * rejects on its own deadline long before the test budget is reached. So a starved runner
 * produces an ASSERTION failure (`expected false to be true`) instead of a timeout, which
 * is why this never looked like the problem vitest.config.ts already describes:
 *
 * > Nothing about the code under test is racy; the measurement apparatus was.
 *
 * That comment raised `testTimeout` to 30s for #852's "rotating cast of unrelated files".
 * The same starvation, one level down, has been reported separately ever since as #1325 —
 * and the two were never connected because one shape says TIMEOUT and the other says a
 * boolean was wrong.
 *
 * ## The measurement
 *
 * On `src/__tests__/services/ui-bridge.test.ts` (193 of these waits, every one a real
 * WebSocket handshake or command round-trip over loopback):
 *
 *     idle machine, file alone            0 failures / 10 runs
 *     14 CPU-burning PROCESSES alongside  2 failures /  6 runs
 *
 * Six different tests in that file have been observed failing this way. They have nothing
 * in common except this default — which is the tell.
 *
 * Separate PROCESSES matter: an earlier round on #1325 measured that a local event-loop lag
 * probe adapts to congestion inside its own loop and cannot see cross-process starvation at
 * all. The failures were seen while unrelated builds, agents and a smoke run had the machine
 * busy — not while other vitest workers did.
 *
 * ## Why this is not widening a tolerance to hide a race
 *
 * The same reasoning vitest.config.ts sets out for `testTimeout`: these waits guard the
 * RUNNER being starved of CPU, not a race in product code. No wait in this repo asserts
 * that something happens QUICKLY — none of them is a deadline under test, and none asserts
 * a rejection — so raising the ceiling changes no verdict. A test that would pass still
 * passes; a test that would fail still fails, just later and with its real reason.
 *
 * The cost is bounded and falls only on failures: a genuinely broken wait reports in 15s
 * instead of 1s, inside the existing 30s test budget.
 *
 * If a wait ever needs MORE than this, make it deterministic — inject the clock, drive the
 * event — rather than raising the number.
 */
const DEADLINE_MS = 15_000;

/** Poll briskly: the wait is usually satisfied in one or two ticks, and a short interval
 *  keeps a passing test as fast as it was. */
const INTERVAL_MS = 10;

export function waitFor<T>(
  fn: () => T | Promise<T>,
  opts: { timeout?: number; interval?: number } = {},
): Promise<T> {
  return vi.waitFor(fn, {
    // A FLOOR, not an override. All EIGHT call sites that pass a timeout wanted to wait
    // LONGER than the default — 3000, 10000, 15000, and `IDLE_MS * 20` (2400ms) — so
    // honouring the larger of the two keeps their intent while lifting them clear of a
    // starved scheduler. None of them bounds a budget under test: each waits for something
    // to APPEAR, and nothing asserts that it appears quickly. One of them was already
    // 15000, which is someone hitting this and fixing their own call site.
    //
    // (I first counted three of these with a single-line regex, which missed the ones whose
    // options span lines. Corrected by walking the parens.)
    timeout: Math.max(DEADLINE_MS, opts.timeout ?? 0),
    interval: opts.interval ?? INTERVAL_MS,
  });
}
