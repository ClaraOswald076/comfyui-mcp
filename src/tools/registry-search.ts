import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { searchNodes, getNodePackDetails } from "../services/registry-client.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * The two public-registry DISCOVERY tools collapsed into one
 * action-parameterized `search_custom_nodes` tool (0.50.0 surface
 * consolidation, slice 12).
 *
 * WHY THIS IS ITS OWN TOOL. The first cut of this slice folded search and
 * details into `install_custom_node` alongside the nine lifecycle actions,
 * because discovery→install is the most common path through the family. The
 * owner ruled the other way, and the reason is the same one the admission work
 * in this slice made concrete: these two actions are READ-ONLY, NETWORK-ONLY
 * lookups against registry.comfy.org that need neither a running ComfyUI nor
 * COMFYUI_PATH, while every action on `install_custom_node` either runs
 * third-party pack code or mutates what is installed. Keeping "look something
 * up" in the same tool as "execute a stranger's install script" put two very
 * different blast radii behind one name — and a name is the unit both the
 * call_tool whitelist and the ollama loop-breaker reason about.
 *
 * The cost is one tool slot: once every 0.50.0 slice has landed the fully
 * consolidated surface will be 33 tools rather than 32. (MAX_TOOLS tracks the
 * surface as it stands today, mid-consolidation, and is far higher.)
 *
 * SHAPE: a FLAT object with an `action` enum — deliberately NOT a
 * z.discriminatedUnion, which the MCP SDK renders as a schema with ZERO visible
 * parameters, hiding every input from the model.
 *
 * REQUIREDNESS: only `action` can be schema-required — `query` belongs to
 * "search" and `id` to "details". Every VALUE constraint the old tools had is
 * unchanged at the zod layer (`limit` keeps .int().min(1).max(50), `page` keeps
 * .int().min(1)); the handler enforces per-action presence and names the missing
 * field. Each branch calls the same registry-client function the old tool
 * called, with the same arguments, and returns the identical content block.
 */
export function registerRegistrySearchTools(server: McpServer): void {
  server.tool(
    "search_custom_nodes",
    "Discover ComfyUI custom node PACKS in the public ComfyUI Registry (registry.comfy.org). Read-only and network-only: queries the hosted registry over HTTP and does NOT require a running ComfyUI or COMFYUI_PATH. This searches node PACKS, not models (use download_model action:\"search\") and not local installs (use list_local_models action:\"list\"). To actually install what you find, or to manage packs already installed, use install_custom_node. Driven by the `action` parameter:\n" +
      '- action:"search" — Search by keyword; `query` required. Returns a ranked list of packs with id, name, author, install count, and latest version. The keyword search ranks a fixed window of packs client-side, so when it matches nothing the query is also tried as an exact registry id automatically (e.g. \'comfyui kjnodes\' → \'comfyui-kjnodes\'). Pass a returned id to action:"details" for full info, or to install_custom_node (action:"install").\n' +
      '- action:"details" — Full details for ONE pack by its exact registry id: description, author, license, repository, install count, latest version, the node types it provides, and recent version changelogs. Look up the id via action:"search" first.',
    {
      action: z
        .enum(["search", "details"])
        .describe(
          'Which registry lookup to perform. "search" requires `query` (and takes optional `limit`/`page`); "details" requires `id`.',
        ),
      query: z
        .string()
        .optional()
        .describe(
          'action:"search" — REQUIRED. Keyword(s) to match against pack name/description, e.g. \'impact\', \'controlnet aux\'.',
        ),
      limit: z
        .number()
        .int()
        .min(1)
        .max(50)
        .optional()
        .describe('action:"search" — max results to return (default 10).'),
      page: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe('action:"search" — page number for pagination (default 1).'),
      id: z
        .string()
        .optional()
        .describe(
          'action:"details" — REQUIRED. Exact registry pack id (the \'id\' field from action:"search"), e.g. \'comfyui-impact-pack\'.',
        ),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "search": {
            // `query`/`id` cannot be schema-required in a flat shape, so the
            // handler enforces per-action presence and names the missing field.
            //
            // ABSENCE only, never falsiness: `query: ""` passed z.string()
            // before this consolidation and reached searchNodes, which answers
            // for an empty query (the "no matches" path, then the exact-id
            // retry). A `!query` guard would replace that live answer with
            // generic text.
            if (args.query === undefined) {
              throw new Error(
                'search_custom_nodes action:"search" requires `query` — the keyword(s) to match against pack name/description.',
              );
            }
            const results = await searchNodes(args.query, {
              limit: args.limit,
              page: args.page,
            });

            const text =
              results.length === 0
                ? `No custom nodes found for "${args.query}".`
                : results
                    .map(
                      (r, i) =>
                        `${i + 1}. **${r.name}** (${r.id})\n` +
                        `   ${r.description ?? "No description"}\n` +
                        `   Author: ${r.author} | Installs: ${r.total_install ?? "N/A"} | Version: ${r.latest_version ?? "N/A"}`,
                    )
                    .join("\n\n");

            return { content: [{ type: "text" as const, text }] };
          }
          case "details": {
            if (args.id === undefined) {
              throw new Error(
                'search_custom_nodes action:"details" requires `id` — the exact registry pack id to look up.',
              );
            }
            const details = await getNodePackDetails(args.id);

            const lines = [
              `# ${details.name}`,
              "",
              details.description ?? "",
              "",
              `- **Author**: ${details.author}`,
              `- **License**: ${details.license ?? "N/A"}`,
              `- **Repository**: ${details.repository ?? "N/A"}`,
              `- **Total Installs**: ${details.total_install ?? "N/A"}`,
              `- **Latest Version**: ${details.latest_version ?? "N/A"}`,
              `- **Created**: ${details.created_at ?? "N/A"}`,
              `- **Updated**: ${details.updated_at ?? "N/A"}`,
            ];

            if (details.nodes?.length) {
              lines.push("", "## Nodes Provided", ...details.nodes.map((n) => `- ${n}`));
            }

            if (details.versions?.length) {
              lines.push(
                "",
                "## Recent Versions",
                ...details.versions.slice(0, 5).map(
                  (v) => `- **${v.version}**${v.changelog ? `: ${v.changelog}` : ""}`,
                ),
                // #809: say how many were dropped. This preview has no parameter to raise,
                // so the honest remedy is the upstream index, not an invented lever.
                ...(details.versions.length > 5
                  ? [
                      `- …and ${details.versions.length - 5} older version(s) not shown (fixed 5-version preview — full history at https://registry.comfy.org/)`,
                    ]
                  : []),
              );
            }

            return { content: [{ type: "text" as const, text: lines.join("\n") }] };
          }
          default: {
            // Unreachable given the zod enum, but a clear runtime guard beats a
            // silent undefined if the schema and switch ever drift apart.
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown search_custom_nodes action "${String(exhaustive)}". Expected one of: search, details.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
