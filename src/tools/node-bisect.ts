import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  bisectStart,
  bisectGood,
  bisectBad,
  bisectReset,
  bisectStatus,
} from "../services/node-bisect.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * The five bisect_* tools collapsed into one action-parameterized `bisect`
 * tool (0.49.0 surface consolidation, slice 1).
 *
 * SHAPE: a FLAT object with a single `action` enum — deliberately NOT a
 * z.discriminatedUnion. The MCP SDK renders a discriminated union as a schema
 * with ZERO visible parameters, which hides `action` from the model entirely.
 * A flat enum keeps `action` visible and self-documenting.
 *
 * REQUIREDNESS: every action of this state machine is argument-free — start /
 * good / bad / reset / status each take no additional parameters (the session
 * is module-level state in services/node-bisect.js). So `action` is the only
 * input, and the runtime switch below rejects anything the enum somehow lets
 * through. This is a pure surface consolidation: each branch calls exactly the
 * same service function the old tool did and returns the identical shape.
 */
export function registerNodeBisectTools(server: McpServer): void {
  server.tool(
    "bisect",
    "Binary-search (git-bisect style) over installed ComfyUI custom nodes to find which one causes a problem. A state machine driven by the `action` parameter:\n" +
      "- action:\"start\" — Begin a session over all currently-enabled custom nodes. Enables half and disables the rest for the first test round, then guide the search with good/bad. Prefers the ComfyUI-Manager HTTP API; falls back to toggling .disabled directory suffixes for local installs. A ComfyUI restart may be needed for changes to take effect.\n" +
      "- action:\"good\" — Mark the currently enabled set as GOOD (the problem is absent with this set). Narrows the search to the disabled candidates and enables the next subset. Resolves and reports the culprit when one node remains.\n" +
      "- action:\"bad\" — Mark the currently enabled set as BAD (the problem is present with this set). Narrows the search to the enabled subset and enables the next subset. Resolves and reports the culprit when one node remains.\n" +
      "- action:\"reset\" — Re-enable all custom nodes and clear the session. Use to abort a bisection or restore the installation after the search completes.\n" +
      "- action:\"status\" — Report the current session state: status (idle/running/resolved), the remaining candidate node set, which nodes are enabled this round, and the identified culprit if resolved.\n" +
      "All actions are argument-free; `action` is the only parameter. `good`/`bad` require a session already started with action:\"start\".",
    {
      action: z
        .enum(["start", "good", "bad", "reset", "status"])
        .describe(
          "Which bisect operation to perform. \"start\" begins a session; \"good\"/\"bad\" narrow it (require a running session); \"reset\" clears it and re-enables everything; \"status\" reports state. No other arguments are needed for any action.",
        ),
    },
    async ({ action }) => {
      try {
        let result:
          | Awaited<ReturnType<typeof bisectStart>>
          | ReturnType<typeof bisectStatus>;
        switch (action) {
          case "start":
            result = await bisectStart();
            break;
          case "good":
            result = await bisectGood();
            break;
          case "bad":
            result = await bisectBad();
            break;
          case "reset":
            result = await bisectReset();
            break;
          case "status":
            result = bisectStatus();
            break;
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = action;
            throw new Error(
              `Unknown bisect action "${String(exhaustive)}". Expected one of: start, good, bad, reset, status.`,
            );
          }
        }
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
