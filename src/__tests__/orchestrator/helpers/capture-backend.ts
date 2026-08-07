// A minimal AgentBackend that records the turns PanelAgent actually delivers.
//
// Three fixes in a row (#889, #977, and the run-error notice) landed with their
// DECISION mutation-verified and their CALL SITE not, because everything inside
// PanelAgent.injectEvent / injectRunError is reachable only through a live
// backend. Each time the honest move was to extract the composition into a named
// function and say plainly that one call remained unverified.
//
// That wall is cheap to remove. The backend contract is small — an id, some
// capabilities, an async-iterable `run`, `interrupt`, `listModels` — and the
// "channel in" is a plain async iterable of NeutralTurn. Consuming it is enough
// to see the exact text an injected event puts in front of the agent, which is
// the thing those fixes are ABOUT.
//
// Deliberately not a mock framework: no SDK, no watchdog, no timers. It answers
// one question — "what did the agent actually receive?" — so a test that asks it
// cannot pass for the wrong reason.

import type {
  AgentBackend,
  AgentEvent,
  BackendStartOptions,
  NeutralTurn,
} from "../../../orchestrator/agent-backend.js";

export interface CaptureBackend extends AgentBackend {
  /** Every turn handed to the backend, in order. */
  readonly turns: NeutralTurn[];
  /** Wait until at least `n` turns have arrived (or reject on timeout). */
  waitForTurns(n: number, timeoutMs?: number): Promise<NeutralTurn[]>;
  /** The text of every turn, joined — convenient for a single assertion. */
  allText(): string;
}

export function makeCaptureBackend(opts?: {
  /** Defaults to a vision-capable backend, the common case for render events. */
  vision?: boolean;
}): CaptureBackend {
  const turns: NeutralTurn[] = [];
  const waiters: Array<() => void> = [];

  const backend: CaptureBackend = {
    id: "claude" as AgentBackend["id"],
    capabilities: {
      vision: opts?.vision ?? true,
      audio: false,
      modelEnumeration: false,
    } as AgentBackend["capabilities"],
    turns,
    async *run(o: BackendStartOptions): AsyncIterable<AgentEvent> {
      // Drain the channel forever, recording what arrives. Yielding nothing is
      // correct: this backend models a provider that receives turns and produces
      // no output, which is all these assertions need.
      for await (const turn of o.channel as AsyncIterable<NeutralTurn>) {
        turns.push(turn);
        while (waiters.length) waiters.pop()?.();
      }
    },
    async interrupt() {},
    async listModels() {
      return [];
    },
    async close() {},
    waitForTurns(n, timeoutMs = 2000) {
      if (turns.length >= n) return Promise.resolve(turns);
      return new Promise((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error(`only ${turns.length} turn(s) arrived, wanted ${n}`)),
          timeoutMs,
        );
        const check = () => {
          if (turns.length >= n) {
            clearTimeout(deadline);
            resolve(turns);
          } else {
            waiters.push(check);
          }
        };
        waiters.push(check);
      });
    },
    allText() {
      return turns.map((t) => t.text).join("\n");
    },
  };
  return backend;
}
