import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  RetiredRedirectUnavailableError,
  installRetiredNameRedirect,
  tryInstallRetiredNameRedirect,
} from "../../tools/retired-redirect.js";
import { DEAD_NAMES, retiredToolMessage } from "../../tools/vocabulary.js";
import { logger } from "../../utils/logger.js";

/**
 * Two things are under test here and they fail for different reasons, so keep them
 * apart when reading:
 *
 *  1. BEHAVIOUR — a retired name gets the ledger redirect on the DIRECT `tools/call`
 *     path, and nothing else about dispatch changes.
 *  2. THE INTERCEPTION ITSELF — the wrapper is genuinely installed where the SDK
 *     dispatches from. Group 1 alone is not enough: the SDK answers an unregistered
 *     name with `{isError: true, content:[{text: "Tool X not found"}]}`, so a lazy
 *     assertion (`isError === true`, or a match on /not found/) passes with the whole
 *     wrapper removed. Group 2 exists because the capture reads two PRIVATE fields of
 *     @modelcontextprotocol/sdk: the failure mode we cannot afford is the wrapper
 *     silently becoming a no-op on an SDK bump, with CI green and every retired name
 *     back to a bare 404. package.json caps the SDK at the verified minor so the bump
 *     is always a deliberate edit; these tests are what that edit has to survive.
 */

/**
 * A real retired name, taken FROM the ledger rather than spelled out.
 *
 * Two reasons, and the second is the load-bearing one:
 *
 *  1. A literal would rot. DEAD_NAMES is append-only, so the first entry is stable, but
 *     nothing here should depend on WHICH name that is.
 *  2. A hard-coded retired name in `src/` is itself a dead-name-gate violation
 *     (scripts/check-tool-vocabulary.mts fails CI on every live mention), and the fix
 *     for that is a per-occurrence `allowedIn` exemption in vocabulary.ts pinned to a
 *     substring of this line. Earning three exemptions so a test can say a string it
 *     can equally well read from the ledger is how exemption lists grow until they stop
 *     meaning anything. Deriving needs none.
 *
 * The expected MESSAGE is derived the same way — via `retiredToolMessage` — so the
 * wording lives only in vocabulary.ts and this file asserts DELIVERY, not prose.
 *
 * The `??` is not defensive noise: `DEAD_NAMES[0]!.name` would throw at MODULE LOAD on
 * an empty ledger, which takes the premise assertion below down with it and reports a
 * TypeError instead of the actual cause. The placeholder lets that assertion run and
 * say what happened.
 */
const RETIRED = DEAD_NAMES[0]?.name ?? "__ledger_is_empty__";

function toolResultText(result: unknown): string {
  const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
  return content
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
}

/** A tiny REAL McpServer: real SDK registration, real dispatch, no ComfyUI. */
function makeServer(register?: (server: McpServer) => void): McpServer {
  const server = new McpServer({ name: "retired-redirect-test", version: "0.0.0" });
  server.tool("echo", "Echo a string.", { value: z.string().describe("Anything.") }, async (args) => ({
    content: [{ type: "text" as const, text: `echo:${args.value}` }],
  }));
  register?.(server);
  return server;
}

async function connect(server: McpServer): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "retired-redirect-test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** Server + install + connected client, the shape most behaviour tests want. */
async function connectedWithRedirect(register?: (server: McpServer) => void): Promise<Client> {
  const server = makeServer(register);
  await installRetiredNameRedirect(server);
  return connect(server);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the ledger this file reads from", () => {
  // Every test below is meaningless against an empty ledger — and would pass, because
  // "no retired name redirects" is vacuously true. Assert the premise so an emptied
  // DEAD_NAMES fails HERE, saying what actually happened, rather than turning the whole
  // file green.
  it("holds at least one retired name, with a replacement to redirect to", () => {
    expect(
      DEAD_NAMES.length,
      "DEAD_NAMES is APPEND-ONLY history; emptying it is the documented ratchet bypass.",
    ).toBeGreaterThan(0);
    expect(retiredToolMessage(RETIRED)).toMatch(/Call \S+ .*instead\./);
  });
});

describe("direct tools/call serves the retirement ledger", () => {
  it("answers a retired name with its ledger redirect instead of a bare 404", async () => {
    const client = await connectedWithRedirect();
    const result = await client.callTool({ name: RETIRED, arguments: {} });
    const text = toolResultText(result);

    // Compared against the ledger's own rendering, so the wording lives in exactly one
    // place (vocabulary.ts) and this file cannot drift from it. What this asserts is
    // DELIVERY: that the message reaches a direct caller at all.
    expect(text).toBe(retiredToolMessage(RETIRED));
    // …and that what got delivered is actually rule 6's shape — which version removed
    // it AND what to call instead. A redirect naming no replacement is still a dead
    // end, and the equality above would happily pass for one.
    expect(text).toContain("removed in");
    expect(text).toMatch(/Call \S+ \(action:"\w+"\) instead\./);
    expect(result.isError).toBe(true);
  });

  it("recognises the namespaced form MCP clients actually send", async () => {
    // Clients that namespace tools send `mcp__comfyui__<tool>` rather than the bare
    // name; findDeadName accepts that prefix, and this proves the wrapper hands it the
    // raw wire name rather than something it pre-stripped or rejected.
    const client = await connectedWithRedirect();
    const namespaced = `mcp__comfyui__${RETIRED}`;
    expect(toolResultText(await client.callTool({ name: namespaced, arguments: {} }))).toBe(
      retiredToolMessage(namespaced),
    );
  });

  it("leaves a genuinely unknown name with the SDK's own error", async () => {
    // The whole point of consulting the ledger rather than answering every miss with a
    // redirect: a made-up name is NOT a retired name and must not claim to be. A model
    // told "totally_made_up_xyz was removed in 0.49.0" would go looking for a
    // replacement that never existed.
    const client = await connectedWithRedirect();
    const text = toolResultText(await client.callTool({ name: "totally_made_up_xyz", arguments: {} }));
    expect(text).toContain("Tool totally_made_up_xyz not found");
    expect(text).not.toContain("removed in");
  });

  it("still dispatches a real tool", async () => {
    const client = await connectedWithRedirect();
    const result = await client.callTool({ name: "echo", arguments: { value: "hi" } });
    expect(toolResultText(result)).toBe("echo:hi");
    expect(result.isError ?? false).toBe(false);
  });

  it("lets a REGISTERED name win over the ledger", async () => {
    // registerAutoloadedWorkflows reserves DEAD_NAMES as well as TOOL_NAMES, so this
    // collision cannot happen today — but that is a DIFFERENT module's invariant, and
    // if it regresses the failure must be a tool that runs, not a live capability
    // shadowed by a redirect that sends its caller somewhere else. Wrong answers are
    // worse than missing ones.
    const client = await connectedWithRedirect((server) => {
      server.tool(RETIRED, "A live tool that happens to carry a retired name.", {}, async () => ({
        content: [{ type: "text" as const, text: "live-tool-ran" }],
      }));
    });
    const result = await client.callTool({ name: RETIRED, arguments: {} });
    expect(toolResultText(result)).toBe("live-tool-ran");
    expect(result.isError ?? false).toBe(false);
  });

  it("leaves argument-validation errors to the SDK", async () => {
    const client = await connectedWithRedirect();
    const text = toolResultText(await client.callTool({ name: "echo", arguments: { value: 42 } }));
    expect(text).toContain("Invalid arguments for tool echo");
    expect(text).not.toContain("removed in");
  });

  it("leaves a DISABLED tool's error to the SDK", async () => {
    // A disabled tool stays in the registration table, so it is "registered" for our
    // purposes and must keep the SDK's own "disabled" answer rather than being
    // reported as unknown or retired.
    const client = await connectedWithRedirect((server) => {
      server.tool("parked", "Registered but switched off.", {}, async () => ({
        content: [{ type: "text" as const, text: "never" }],
      })).disable();
    });
    expect(toolResultText(await client.callTool({ name: "parked", arguments: {} }))).toContain(
      "Tool parked disabled",
    );
  });

  it("does not change tools/list", async () => {
    const plain = await connect(makeServer());
    const wrapped = await connectedWithRedirect();
    expect((await wrapped.listTools()).tools.map((t) => t.name)).toEqual(
      (await plain.listTools()).tools.map((t) => t.name),
    );
  });

  it("answers concurrent calls independently", async () => {
    // The wrapper holds no per-call state; this pins that, so a later refactor that
    // hoists something out of the handler shows up here rather than as an occasional
    // wrong answer under load.
    const client = await connectedWithRedirect();
    const [retired, real, unknown] = await Promise.all([
      client.callTool({ name: RETIRED, arguments: {} }),
      client.callTool({ name: "echo", arguments: { value: "concurrent" } }),
      client.callTool({ name: "totally_made_up_xyz", arguments: {} }),
    ]);
    expect(toolResultText(retired)).toBe(retiredToolMessage(RETIRED));
    expect(toolResultText(real)).toBe("echo:concurrent");
    expect(toolResultText(unknown)).toContain("Tool totally_made_up_xyz not found");
  });
});

describe("the interception itself", () => {
  /**
   * THE SDK-BUMP CANARY.
   *
   * Everything above tests behaviour through a client; this tests the mechanism, and
   * it is the one that has to fail when @modelcontextprotocol/sdk moves. It runs the
   * real install against a real McpServer, so any rename of `_requestHandlers` or
   * `_registeredTools`, or any change to what `setRequestHandler` writes, fails HERE,
   * on the bump's own PR, with the failed assumption named in the error.
   */
  it("installs against the real SDK, and the failure names what moved", async () => {
    await expect(
      installRetiredNameRedirect(makeServer()),
      "The retired-name redirect could not attach to @modelcontextprotocol/sdk. If this " +
        "started failing after an SDK upgrade, the private fields it captures have moved — " +
        "the thrown message names which one. Do NOT delete this test or soften the install: " +
        "without the wrapper every name retired by a consolidation slice answers with a bare " +
        "404 instead of naming its replacement, and nothing else in CI notices.",
    ).resolves.toBeUndefined();
  });

  it("actually replaces the entry the SDK dispatches through", async () => {
    // The post-condition, asserted from outside. If a future SDK keeps
    // `_requestHandlers` but routes setRequestHandler somewhere else, our wrapper is
    // installed into a table nobody reads: every retired name 404s and NO behaviour
    // test can tell, because the SDK's own handler is still there answering.
    const server = makeServer();
    const handlers = (server.server as unknown as { _requestHandlers: Map<string, unknown> })
      ._requestHandlers;
    const before = handlers.get("tools/call");
    expect(typeof before).toBe("function");

    await installRetiredNameRedirect(server);

    const after = handlers.get("tools/call");
    expect(typeof after).toBe("function");
    expect(after).not.toBe(before);
  });

  it("refuses when the map holds a THIRD function that is not the wrapper", async () => {
    // Identity with our own handler is not assertable — setRequestHandler stores its
    // own closure around it — so "the entry changed" is all a comparison can say, and
    // that passes for anything that is merely not the original. This is the case it
    // waves through: an SDK that writes some OTHER function into the slot would report
    // the redirect ACTIVE while this wrapper never runs. Only driving the installed
    // entry and demanding the ledger's answer catches it.
    const server = makeServer();
    const handlers = (server.server as unknown as { _requestHandlers: Map<string, unknown> })
      ._requestHandlers;
    vi.spyOn(server.server, "setRequestHandler").mockImplementation(() => {
      handlers.set("tools/call", () => Promise.resolve({ content: [], isError: true }));
    });
    await expect(installRetiredNameRedirect(server)).rejects.toThrow(
      /did not serve the ledger for the retired name/,
    );
    await expect(installRetiredNameRedirect(server)).rejects.toThrow(
      /Something other than this wrapper is answering tools\/call/,
    );
  });

  it("refuses when the installed handler throws on the self-test", async () => {
    const server = makeServer();
    const handlers = (server.server as unknown as { _requestHandlers: Map<string, unknown> })
      ._requestHandlers;
    vi.spyOn(server.server, "setRequestHandler").mockImplementation(() => {
      handlers.set("tools/call", () => {
        throw new Error("dispatch exploded");
      });
    });
    await expect(installRetiredNameRedirect(server)).rejects.toThrow(
      /threw on a self-test call for the retired name/,
    );
  });

  it("refuses when server.server._requestHandlers is not a Map", async () => {
    const server = makeServer();
    (server.server as unknown as { _requestHandlers: unknown })._requestHandlers = {};
    await expect(installRetiredNameRedirect(server)).rejects.toThrow(
      RetiredRedirectUnavailableError,
    );
    await expect(installRetiredNameRedirect(server)).rejects.toThrow(
      /_requestHandlers is not a Map/,
    );
  });

  it("refuses when there is no tools/call handler to wrap", async () => {
    // Reachable by our own mistake, not only by an SDK change: the SDK installs
    // tools/call LAZILY on the first server.tool(), so installing before any
    // registration silently wraps nothing. The message says so instead of blaming the
    // dependency.
    const bare = new McpServer({ name: "no-tools", version: "0.0.0" });
    await expect(installRetiredNameRedirect(bare)).rejects.toThrow(/no 'tools\/call' function/);
    await expect(installRetiredNameRedirect(bare)).rejects.toThrow(
      /install this AFTER registering tools/,
    );
  });

  it("refuses when server._registeredTools is missing", async () => {
    const server = makeServer();
    delete (server as unknown as { _registeredTools?: unknown })._registeredTools;
    await expect(installRetiredNameRedirect(server)).rejects.toThrow(
      /_registeredTools is missing/,
    );
  });

  it("refuses when server._registeredTools is empty despite a live tools/call handler", async () => {
    // The decoy case: the field exists and is an object, but is not the table the SDK
    // is filling. Proceeding would treat every name as unregistered and let the ledger
    // shadow live tools.
    const server = makeServer();
    (server as unknown as { _registeredTools: unknown })._registeredTools = {};
    await expect(installRetiredNameRedirect(server)).rejects.toThrow(/_registeredTools is empty/);
  });

  it("refuses when setRequestHandler does not land in the captured map", async () => {
    // Simulates the silent-no-op an SDK change could cause: the install "succeeds",
    // the wrapper exists, and nothing dispatches to it.
    const server = makeServer();
    vi.spyOn(server.server, "setRequestHandler").mockImplementation(() => undefined);
    await expect(installRetiredNameRedirect(server)).rejects.toThrow(
      /did not replace the 'tools\/call' entry/,
    );
    await expect(installRetiredNameRedirect(server)).rejects.toThrow(
      /so the wrapper would never run/,
    );
  });

  it("degrades loudly rather than throwing, and says live tools are unaffected", async () => {
    // The production call sites use tryInstall…: refusing to BOOT to protect the
    // quality of one error message is the worse outage. The canary above, plus the
    // `~1.29.0` cap in package.json, are what stop a broken capture from shipping.
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    const bare = new McpServer({ name: "no-tools", version: "0.0.0" });

    await expect(tryInstallRetiredNameRedirect(bare)).resolves.toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    const logged = error.mock.calls[0]?.[0] ?? "";
    expect(logged).toContain("NOT active");
    expect(logged).toContain("Live tools are unaffected");
    expect(logged).toContain("no 'tools/call' function");

    // …and the server it declined to patch is still usable, which is the whole point
    // of degrading: a bare 404 beats a dead server.
    bare.tool("echo", "Echo.", { value: z.string() }, async (args) => ({
      content: [{ type: "text" as const, text: `echo:${args.value}` }],
    }));
    const client = await connect(bare);
    expect(toolResultText(await client.callTool({ name: "echo", arguments: { value: "ok" } }))).toBe(
      "echo:ok",
    );
  });

  it("reports success on a healthy server", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    await expect(tryInstallRetiredNameRedirect(makeServer())).resolves.toBe(true);
    expect(error).not.toHaveBeenCalled();
  });
});
