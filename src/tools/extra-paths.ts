import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  addExtraPath,
  listExtraPaths,
  removeExtraPath,
  type ExtraPathTarget,
} from "../services/extra-paths.js";
import { errorToToolResult } from "../utils/errors.js";

/**
 * The three extra-search-path handlers, no longer registered as tools of their own.
 *
 * 0.50.0 slice 11 folded them into `list_local_models` (action:"list_paths" /
 * "add_path" / "remove_path"); see ./model-management.ts for the dispatcher and
 * the merged schema.
 *
 * THE POINT OF KEEPING THEM HERE, UNCHANGED: list/add/remove are a
 * read/write/write set over ONE file — extra_model_paths.yaml (or the Desktop
 * extra_models_config.yaml) — and a corrupted copy of that file makes ComfyUI
 * unable to find ANY model. So the fold must not change WHEN the file is written
 * or HOW it is serialized. It does not: each function is the old handler body
 * verbatim, mapping the same snake_case arguments onto the same service options
 * and JSON-stringifying the same result. The services in
 * ../services/extra-paths.ts are untouched, and the only writers remain
 * addExtraPath / removeExtraPath — reached from exactly two of the six actions,
 * the same two that used to be their own tools.
 */

/** Arguments shared by all three, mapped 1:1 onto the service's options. */
interface ExtraPathTargetArgs {
  target?: ExtraPathTarget;
  config_path?: string;
}

/** The two mutations additionally require a category + a path. */
interface ExtraPathMutationArgs extends ExtraPathTargetArgs {
  group?: string;
  category: string;
  path: string;
}

export async function listExtraPathsAction(
  args: ExtraPathTargetArgs,
): Promise<CallToolResult> {
      try {
        const result = await listExtraPaths({
          target: args.target,
          configPath: args.config_path,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
}

export async function addExtraPathAction(
  args: ExtraPathMutationArgs & { is_default?: boolean },
): Promise<CallToolResult> {
      try {
        const result = await addExtraPath({
          target: args.target,
          configPath: args.config_path,
          group: args.group,
          category: args.category,
          path: args.path,
          isDefault: args.is_default,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
}

export async function removeExtraPathAction(
  args: ExtraPathMutationArgs,
): Promise<CallToolResult> {
      try {
        const result = await removeExtraPath({
          target: args.target,
          configPath: args.config_path,
          group: args.group,
          category: args.category,
          path: args.path,
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return errorToToolResult(err);
      }
}
