import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listRegisteredToolNames } from "../../tools/introspect.js";
import { MAX_TOOLS, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The surface gate: what a client can actually see must equal the ledger in
 * src/tools/vocabulary.ts, exactly and in order.
 *
 * This asserts over the REAL registration pass through a REAL MCP client, so a
 * tool only counts here if the SDK genuinely advertises it — a registration the
 * SDK silently drops cannot pass by being "registered".
 *
 * Two isolations make it deterministic on any machine:
 *
 *  1. COMFYUI_WORKFLOWS_DIR → an empty temp dir. registerAllTools() ends with
 *     registerAutoloadedWorkflows(), which registers ONE TOOL PER SAVED
 *     WORKFLOW FILE. Without this the registered count is a function of the
 *     developer's ~/.comfyui-mcp/workflows, so the test would pass on a clean
 *     checkout and fail for anyone who has ever saved a workflow. It also means
 *     the tool-count budget is only meaningful about the STATIC surface — see
 *     the note on MAX_TOOLS below.
 *  2. COMFYUI_MCP_TOOL_MODE → unset. `compact` swaps the whole surface for 3
 *     meta-tools (src/tools/compact.ts), so a stray export in a dev shell would
 *     fail this with a wildly confusing 178-name diff.
 */
describe("registered tool surface", () => {
  let names: string[];
  let served: string[];
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    for (const key of ["COMFYUI_WORKFLOWS_DIR", "COMFYUI_MCP_TOOL_MODE", "COMFYUI_MCP_NO_FACADE"]) {
      saved[key] = process.env[key];
    }
    process.env.COMFYUI_WORKFLOWS_DIR = await mkdtemp(join(tmpdir(), "comfyui-mcp-surface-"));
    delete process.env.COMFYUI_MCP_TOOL_MODE;
    // The served-surface assertions below are about the DEFAULT full-mode surface,
    // which layers the facade. `=1` in a dev shell would drop the three meta-tools and
    // fail those with an off-by-three nobody would guess the cause of.
    delete process.env.COMFYUI_MCP_NO_FACADE;
    names = await listRegisteredToolNames();
    served = await listRegisteredToolNames("served");
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  // Set equality FIRST, and reported as names rather than as a 181-element array
  // mismatch: the diff is the actionable part. "+ foo_bar" tells you what to add
  // to the ledger; a raw array assertion on 181 strings tells you nothing.
  it("registers no tool missing from the ledger, and no ledger name that is missing", () => {
    const ledger = new Set<string>(TOOL_NAMES);
    const registered = new Set(names);
    const undeclared = names.filter((n) => !ledger.has(n));
    const missing = TOOL_NAMES.filter((n) => !registered.has(n));

    expect(
      { undeclared, missing },
      "Registered surface diverged from src/tools/vocabulary.ts. " +
        "`undeclared` = registered but not in TOOL_NAMES (add it, or don't register it). " +
        "`missing` = in TOOL_NAMES but not registered (remove it, and add it to DEAD_NAMES).",
    ).toEqual({ undeclared: [], missing: [] });
  });

  // Order is a separate assertion from membership so a pure reordering produces
  // "order changed" rather than an empty set-diff that looks like a pass.
  // tools/list returns registration order and src/tools/index.ts documents it as
  // observable — models read the surface top-down, so a reshuffle is a real
  // behavioural change even though the set is identical.
  it("registers them in ledger order", () => {
    expect(names).toEqual([...TOOL_NAMES]);
  });

  // The Glama score input. This bounds the STATIC surface only — autoloaded
  // saved-workflow tools are excluded above, and until Phase 4 collapses them
  // into comfy_run{action:"saved"} a real machine can still exceed this at
  // runtime. That gap is the point of Phase 4, not an oversight here.
  it(`stays within the ${MAX_TOOLS}-tool budget`, () => {
    expect(names.length).toBeLessThanOrEqual(MAX_TOOLS);
  });

  // What a full-mode client is OFFERED is not the ledger — it is the ledger plus the
  // three facade meta-tools layered on for reconnect resilience (#616,
  // registerFullTools). `call_tool` / `list_tools` / `describe_tool` are in no ledger
  // and no baseline by design (they are the meta-surface, not capabilities), so
  // full-mode `tools/list` returns MAX_TOOLS + 3 while every gate in this repo counts
  // MAX_TOOLS. That off-by-three is exactly the kind of thing the 0.50.0 flip (#726)
  // has to assert against, and it was previously asserted nowhere: every surface test
  // above stops at registerAllTools and never sees the facade.
  //
  // Expressed against MAX_TOOLS rather than today's number so it survives each
  // consolidation slice landing — only the "+ 3" is the claim being pinned.
  const FACADE = ["list_tools", "describe_tool", "call_tool"] as const;
  it(`serves exactly MAX_TOOLS + ${FACADE.length} tools in full mode`, () => {
    expect(served.length).toBe(MAX_TOOLS + FACADE.length);
  });

  // Separate from the count, because a count alone would still pass if the facade
  // vanished and three ledger names appeared twice, or if a rename made one of them
  // something else. This says WHICH three the surplus is.
  it("adds exactly the three facade meta-tools over the ledger surface", () => {
    const ledger = new Set<string>(TOOL_NAMES);
    expect(served.filter((n) => !ledger.has(n)).sort()).toEqual([...FACADE].sort());
  });

  // The direction that matters for the ledger gate: layering the facade must not DROP
  // or reorder a ledger tool. Without this, "served = ledger + 3" would also hold if
  // the facade replaced three ledger names with itself.
  it("serves every ledger tool, in ledger order, alongside the facade", () => {
    const facade = new Set<string>(FACADE);
    expect(served.filter((n) => !facade.has(n))).toEqual([...TOOL_NAMES]);
  });

  // A duplicate in the ledger makes the set comparison above silently weaker
  // (Set collapses it) while the order comparison fails for a reason nobody
  // would guess from the message.
  it("has no duplicate names in the ledger", () => {
    const seen = new Set<string>();
    const duplicates = TOOL_NAMES.filter((n) => (seen.has(n) ? true : (seen.add(n), false)));
    expect(duplicates).toEqual([]);
  });
});
