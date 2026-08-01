// Unit tests for the pi.dev CLI backend (pi-backend.ts, issue #491).
//
// We cannot run the real `pi` here, so `node:child_process` is mocked: spawn()
// returns an in-process fake child whose scripted stdout/stderr/exit behavior is
// set per test. This exercises the real PiBackend end-to-end: executable
// resolution (env override), spawn argv shaping (--mode json / --session /
// --model / --provider / positional prompt), the JSON-lines → delta → assistant →
// result event mapping, session-id capture + resume, the terminal-result
// invariant on failures, interrupt, tool-secret scoping, and `pi --list-models`
// parsing.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type { AgentEvent, NeutralTurn } from "../../orchestrator/agent-backend.js";

const hoisted = vi.hoisted(() => ({
  spawns: [] as Array<{ cmd: string; args: string[]; opts: Record<string, unknown> }>,
  procs: [] as Array<Record<string, unknown>>,
  killed: [] as number[],
  script: [] as Array<{ stdout?: string[]; stderr?: string; exit?: number | null; hang?: boolean }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");

  function spawnFake(cmd: string, args: string[], opts: Record<string, unknown>) {
    hoisted.spawns.push({ cmd, args, opts });
    const proc = new EventEmitter() as InstanceType<typeof EventEmitter> & Record<string, unknown>;
    proc.pid = 5000 + hoisted.procs.length;
    proc.exitCode = null;
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    proc.stdout = stdout;
    proc.stderr = stderr;
    proc.stdin = null;
    proc.kill = () => {
      if (proc.exitCode === null) {
        proc.exitCode = 1;
        proc.emit("exit", 1, "SIGTERM");
      }
      return true;
    };
    hoisted.procs.push(proc);
    const step = hoisted.script[Math.min(hoisted.procs.length - 1, hoisted.script.length - 1)] ?? {
      stdout: ['{"type":"agent_end","messages":[]}\n'],
      exit: 0,
    };
    setTimeout(() => {
      for (const chunk of step.stdout ?? []) stdout.write(chunk);
      if (step.stderr) stderr.write(step.stderr);
      if (!step.hang) {
        setTimeout(() => {
          if (proc.exitCode === null) {
            proc.exitCode = step.exit ?? 0;
            proc.emit("exit", step.exit ?? 0, null);
          }
        }, 5);
      }
    }, 5);
    return proc;
  }

  return {
    ...actual,
    spawn: vi.fn(spawnFake),
    spawnSync: vi.fn((cmd: string, args: string[]) => {
      if (/taskkill/i.test(cmd)) {
        const pid = Number(args[1]);
        hoisted.killed.push(pid);
        const proc = hoisted.procs.find((p) => p.pid === pid);
        if (proc && proc.exitCode === null) {
          proc.exitCode = 1;
          (proc as { emit: (ev: string, ...a: unknown[]) => void }).emit("exit", null, "SIGKILL");
        }
      }
      return { status: 0, stdout: "", stderr: "" };
    }),
  };
});

import {
  PiBackend,
  parsePiModels,
  parsePiDurationMs,
  resolvePiBin,
} from "../../orchestrator/pi-backend.js";
import { backendReadiness } from "../../orchestrator/backend-readiness.js";

const FAKE_BIN = join(tmpdir(), "fake-pi", "pi.exe");

async function* channelOf(turns: NeutralTurn[]): AsyncGenerator<NeutralTurn> {
  for (const t of turns) yield t;
}

async function collect(gen: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

/** One text delta event line. */
const delta = (s: string) =>
  `${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: s } })}\n`;
const header = (id: string) => `${JSON.stringify({ type: "session", version: 3, id })}\n`;
const END = '{"type":"agent_end","messages":[]}\n';

let workDir: string;

beforeEach(() => {
  hoisted.spawns.length = 0;
  hoisted.procs.length = 0;
  hoisted.killed.length = 0;
  hoisted.script.length = 0;
  // Emulate the POSIX process-group kill path too (Windows uses taskkill via the
  // spawnSync mock) so interrupt tests behave identically on every platform.
  vi.spyOn(process, "kill").mockImplementation(((pid: number) => {
    const target = Math.abs(Number(pid));
    hoisted.killed.push(target);
    const proc = hoisted.procs.find((p) => p.pid === target);
    if (proc && proc.exitCode === null) {
      proc.exitCode = 1;
      (proc as { emit: (ev: string, ...a: unknown[]) => void }).emit("exit", null, "SIGKILL");
    }
    return true;
  }) as unknown as typeof process.kill);
  process.env.COMFYUI_MCP_PI_PATH = FAKE_BIN;
  delete process.env.COMFYUI_MCP_PI_PRINT_TIMEOUT;
  workDir = mkdtempSync(join(tmpdir(), "pi-test-"));
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PI_PATH;
  rmSync(workDir, { recursive: true, force: true });
  vi.mocked(process.kill).mockRestore?.();
});

describe("parsePiModels", () => {
  it("parses a padded table with a header, id = provider/model", () => {
    const out = [
      "provider   model            context   max-out   thinking   images",
      "anthropic  claude-sonnet-4  200K      64K       yes        yes",
      "openai     gpt-4o           128K      16K       no         yes",
      "",
    ].join("\n");
    const models = parsePiModels(out);
    expect(models.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-4", "openai/gpt-4o"]);
    expect(models[0]!.label).toBe("claude-sonnet-4");
  });

  it("strips ANSI and skips separator rules", () => {
    const out = "[32manthropic[0m  claude-3-5-sonnet  200K\n────────  ──────  ──────\n";
    expect(parsePiModels(out).map((m) => m.id)).toEqual(["anthropic/claude-3-5-sonnet"]);
  });

  it("returns [] for garbage / prose", () => {
    expect(parsePiModels("Something went wrong.\nPlease configure a provider.")).toEqual([]);
  });

  it("parsePiDurationMs handles duration forms", () => {
    expect(parsePiDurationMs("45m")).toBe(45 * 60_000);
    expect(parsePiDurationMs("1h30m")).toBe(90 * 60_000);
    expect(parsePiDurationMs("banana")).toBeNull();
  });
});

describe("resolvePiBin / readiness", () => {
  it("honors the COMFYUI_MCP_PI_PATH override and reads ready when the CLI is present", () => {
    expect(resolvePiBin()).toBe(FAKE_BIN);
    const r = backendReadiness("pi", { home: workDir });
    expect(r.backend).toBe("pi");
    expect(r.cli).toBe(true);
    expect(r.ready).toBe(true); // ready keys off CLI presence (auth verified at connect)
  });

  it("reports not-ready when the CLI is absent", () => {
    delete process.env.COMFYUI_MCP_PI_PATH;
    const savedPath = process.env.PATH;
    const savedLad = process.env.LOCALAPPDATA;
    process.env.PATH = workDir;
    process.env.LOCALAPPDATA = workDir;
    try {
      const r = backendReadiness("pi", { home: workDir });
      expect(r.ready).toBe(false);
      expect(r.cli).toBe(false);
    } finally {
      process.env.PATH = savedPath;
      if (savedLad === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = savedLad;
    }
  });
});

describe("PiBackend turns", () => {
  it("streams JSON deltas, captures + re-emits the session id, and resumes with --session on turn 2", async () => {
    hoisted.script.push(
      { stdout: [header("sess-abc"), delta("Hello "), delta("world"), END], exit: 0 },
      { stdout: [header("sess-abc"), delta("Second"), END], exit: 0 },
    );
    const backend = new PiBackend({ cwd: workDir, model: "openai/gpt-4o", systemAppend: "PERSONA" });
    const events = await collect(
      backend.run({ channel: channelOf([{ text: "hi" }, { text: "again" }]) }),
    );

    // First a provisional session (sentinel), then the REAL id from the header.
    expect(events[0]).toMatchObject({ type: "session", sessionId: "pi-pending", model: "openai/gpt-4o" });
    expect(events.some((e) => e.type === "session" && (e as { sessionId: string }).sessionId === "sess-abc")).toBe(true);
    expect(events.filter((e) => e.type === "assistant").map((e) => (e as { text: string }).text)).toEqual([
      "Hello world",
      "Second",
    ]);
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: true, subtype: "end_turn" },
      { type: "result", ok: true, subtype: "end_turn" },
    ]);

    // Turn 1: fresh (no --session), --mode json, persona prepended, model set.
    const t1 = hoisted.spawns[0]!;
    expect(t1.cmd).toBe(FAKE_BIN);
    expect(t1.args).not.toContain("--session");
    expect(t1.args).toContain("--mode");
    expect(t1.args[t1.args.indexOf("--mode") + 1]).toBe("json");
    expect(t1.args[t1.args.indexOf("--model") + 1]).toBe("openai/gpt-4o");
    expect(t1.args[t1.args.length - 1]).toContain("PERSONA");
    expect(t1.args[t1.args.length - 1]).toContain("hi");
    // Turn 2: resumes the captured session id, no persona.
    const t2 = hoisted.spawns[1]!;
    expect(t2.args[t2.args.indexOf("--session") + 1]).toBe("sess-abc");
    expect(t2.args[t2.args.length - 1]).toBe("again");
  });

  it("emits per-tool events from tool_execution_* lines", async () => {
    hoisted.script.push({
      stdout: [
        header("s1"),
        '{"type":"tool_execution_start","toolCallId":"c1","toolName":"bash","args":{"command":"ls"}}\n',
        '{"type":"tool_execution_end","toolCallId":"c1","toolName":"bash","result":{},"isError":false}\n',
        delta("done"),
        END,
      ],
      exit: 0,
    });
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "run ls" }]) }));
    const tools = events.filter((e) => e.type === "tool_call") as Array<{ name: string; phase: string }>;
    expect(tools.map((t) => `${t.name}:${t.phase}`)).toEqual(["bash:start", "bash:end"]);
  });

  it("uses --session from opts.resume and skips the persona", async () => {
    hoisted.script.push({ stdout: [header("sess-r"), delta("resumed"), END], exit: 0 });
    const backend = new PiBackend({ cwd: workDir, systemAppend: "PERSONA" });
    await collect(backend.run({ resume: "sess-existing", channel: channelOf([{ text: "back" }]) }));
    const t1 = hoisted.spawns[0]!;
    expect(t1.args[t1.args.indexOf("--session") + 1]).toBe("sess-existing");
    expect(t1.args[t1.args.length - 1]).toBe("back"); // no persona preamble
  });

  it("drops a bare claude id (no --model) but honors a provider-prefixed id", async () => {
    hoisted.script.push({ stdout: [header("s"), delta("x"), END], exit: 0 });
    const backend = new PiBackend({ cwd: workDir });
    await collect(backend.run({ model: "claude-opus-4-8", channel: channelOf([{ text: "q" }]) }));
    expect(hoisted.spawns[0]!.args).not.toContain("--model");
    await backend.setModel("anthropic/claude-sonnet-4");
    hoisted.script.push({ stdout: [header("s"), delta("y"), END], exit: 0 });
    await collect(backend.run({ resume: "s", channel: channelOf([{ text: "q2" }]) }));
    const t2 = hoisted.spawns[1]!;
    expect(t2.args[t2.args.indexOf("--model") + 1]).toBe("anthropic/claude-sonnet-4");
  });

  it("passes --provider when configured", async () => {
    hoisted.script.push({ stdout: [header("s"), delta("ok"), END], exit: 0 });
    const backend = new PiBackend({ cwd: workDir, provider: "openai" });
    await collect(backend.run({ channel: channelOf([{ text: "q" }]) }));
    const t1 = hoisted.spawns[0]!;
    expect(t1.args[t1.args.indexOf("--provider") + 1]).toBe("openai");
  });

  it("spawns pi WITHOUT ComfyUI tool-only secrets but keeps its own provider keys", async () => {
    const saved = {
      RUNPOD_API_KEY: process.env.RUNPOD_API_KEY,
      CIVITAI_API_TOKEN: process.env.CIVITAI_API_TOKEN,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    };
    process.env.RUNPOD_API_KEY = "rp-tool-secret";
    process.env.CIVITAI_API_TOKEN = "civ-tool-secret";
    process.env.ANTHROPIC_API_KEY = "sk-ant-pi-key";
    try {
      hoisted.script.push({ stdout: [header("s"), delta("ok"), END], exit: 0 });
      const backend = new PiBackend({ cwd: workDir });
      await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
      const env = hoisted.spawns[0]!.opts.env as Record<string, string | undefined>;
      expect(env.RUNPOD_API_KEY).toBeUndefined(); // tool secret — stripped
      expect(env.CIVITAI_API_TOKEN).toBeUndefined(); // tool secret — stripped
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-pi-key"); // pi's own provider key — kept
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it("surfaces a failed exit as error + failed result (terminal-result invariant)", async () => {
    hoisted.script.push({ stdout: [header("s")], stderr: "boom: quota exceeded", exit: 7 });
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toContain("code 7");
    expect(err.message).toContain("quota exceeded");
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "error" },
    ]);
  });

  it("maps a credential-looking failure to provider-setup guidance", async () => {
    hoisted.script.push({ stdout: [], stderr: "no provider configured: set an API key", exit: 1 });
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toMatch(/provider credentials|API key|login/i);
  });

  it("interrupt kills the in-flight child tree and yields a cancelled result", async () => {
    hoisted.script.push({ hang: true });
    const backend = new PiBackend({ cwd: workDir });
    const gen = backend.run({ channel: channelOf([{ text: "long job" }]) });
    const events: AgentEvent[] = [];
    const drain = (async () => {
      for await (const ev of gen) events.push(ev);
    })();
    await vi.waitFor(() => expect(hoisted.spawns.length).toBe(1));
    await backend.interrupt();
    await drain;
    expect(hoisted.killed).toContain(hoisted.procs[0]!.pid);
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "cancelled" },
    ]);
  });

  it("honors an interrupt that lands BEFORE the child is assigned (spawn window)", async () => {
    hoisted.script.push({ hang: true });
    const backend = new PiBackend({ cwd: workDir });
    const gen = backend.run({ channel: channelOf([{ text: "long job" }]) });
    const events: AgentEvent[] = [];
    const drain = (async () => {
      for await (const ev of gen) events.push(ev);
    })();
    await backend.interrupt();
    await drain;
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: false, subtype: "cancelled" },
    ]);
    if (hoisted.procs[0]) expect(hoisted.killed).toContain(hoisted.procs[0]!.pid);
  });

  it("an idle interrupt expires and does not cancel the next turn (stale-flag regression)", async () => {
    hoisted.script.push({ stdout: [header("s"), delta("fine"), END], exit: 0 });
    const backend = new PiBackend({ cwd: workDir });
    await backend.interrupt();
    await new Promise((r) => setTimeout(r, 650));
    const events = await collect(backend.run({ channel: channelOf([{ text: "hi" }]) }));
    expect(events.filter((e) => e.type === "result")).toEqual([
      { type: "result", ok: true, subtype: "end_turn" },
    ]);
    expect(hoisted.killed).toEqual([]);
  });

  it("kills the child when the generator is abandoned mid-turn without close()", async () => {
    hoisted.script.push({ stdout: [header("s"), delta("partial ")], hang: true });
    const backend = new PiBackend({ cwd: workDir });
    const gen = backend.run({ channel: channelOf([{ text: "long" }]) });
    let ev = await gen.next();
    while (!ev.done && (ev.value as { type: string }).type !== "stream_start") {
      ev = await gen.next();
    }
    await gen.return(undefined);
    expect(hoisted.killed).toContain(hoisted.procs[0]!.pid);
  });

  it("rejects an over-32K prompt on Windows with a legible error", async () => {
    if (process.platform !== "win32") return;
    const backend = new PiBackend({ cwd: workDir });
    const events = await collect(backend.run({ channel: channelOf([{ text: "x".repeat(31_000) }]) }));
    expect(hoisted.spawns).toHaveLength(0);
    const err = events.find((e) => e.type === "error") as { message: string };
    expect(err.message).toMatch(/too large/i);
  });

  it("prepare() fails fast with install guidance when pi is missing", async () => {
    delete process.env.COMFYUI_MCP_PI_PATH;
    const savedPath = process.env.PATH;
    const savedLad = process.env.LOCALAPPDATA;
    process.env.PATH = workDir;
    process.env.LOCALAPPDATA = workDir;
    try {
      const backend = new PiBackend({ cwd: workDir });
      await expect(backend.prepare()).rejects.toThrow(/pi\.dev/);
    } finally {
      process.env.PATH = savedPath;
      if (savedLad === undefined) delete process.env.LOCALAPPDATA;
      else process.env.LOCALAPPDATA = savedLad;
    }
  });
});

describe("PiBackend.listModels", () => {
  it("runs `pi --list-models` and parses the table", async () => {
    hoisted.script.push({
      stdout: ["provider   model     context\nopenai     gpt-4o    128K\n"],
      exit: 0,
    });
    const backend = new PiBackend({ cwd: workDir });
    const models = await backend.listModels();
    expect(hoisted.spawns[0]!.args).toEqual(["--list-models"]);
    expect(models.map((m) => m.id)).toEqual(["openai/gpt-4o"]);
  });

  it("rejects with setup guidance on a non-zero exit", async () => {
    hoisted.script.push({ stdout: [], stderr: "boom", exit: 2 });
    const backend = new PiBackend({ cwd: workDir });
    await expect(backend.listModels()).rejects.toThrow(/pi is installed|configured/i);
  });
});
