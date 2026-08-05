import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { evaluateBatch } from "../services/calc-evaluator.js";

/**
 * Split a spec string into individual expressions. We split ONLY on newlines
 * and semicolons — never commas, since commas are argument separators inside
 * call lists like `min(1, 2)`. Blank lines are dropped.
 */
function splitSpec(spec: string): string[] {
  return spec
    .split(/[\n;]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function renderNumber(n: number | null): string {
  if (n === null) return "null";
  if (Number.isNaN(n)) return "NaN";
  if (!Number.isFinite(n)) return n > 0 ? "Infinity" : "-Infinity";
  return String(n);
}

/**
 * `get_system_stats (action:"calculate")` — what the retired `get_system_stats (action:"calculate")` tool
 * did (0.50.0 slice 13). The spec normalization, the evaluator call and BOTH
 * content blocks (rendered summary + raw JSON) are unchanged.
 */
export async function calculateAction(args: {
  spec: string | string[];
  variables?: Record<string, number>;
  seed?: number;
}): Promise<CallToolResult> {
  const exprs = Array.isArray(args.spec)
    ? args.spec.map((s) => s.trim()).filter((s) => s.length > 0)
    : splitSpec(args.spec);

  if (exprs.length === 0) {
    throw new Error("No expressions to evaluate (spec was empty after splitting).");
  }

  const { results, variables, errors, seed } = evaluateBatch(
    exprs,
    args.variables,
    args.seed,
  );

  // Rendered text summary.
  const lines: string[] = [];
  for (let i = 0; i < exprs.length; i++) {
    const r = results[i];
    const rendered = renderNumber(r);
    const flag =
      r !== null && (Number.isNaN(r) || !Number.isFinite(r)) ? "  ⚠ non-finite" : "";
    lines.push(`  [${i + 1}] ${exprs[i]}  =>  ${rendered}${flag}`);
  }

  const varKeys = Object.keys(variables);
  const varLine =
    varKeys.length > 0
      ? varKeys.map((k) => `${k}=${renderNumber(variables[k])}`).join(", ")
      : "(none)";

  const parts: string[] = [];
  parts.push("results:");
  parts.push(lines.join("\n"));
  parts.push("");
  parts.push(`variables: ${varLine}`);
  parts.push(`seed: ${seed}`);
  if (errors.length > 0) {
    parts.push("");
    parts.push("errors:");
    for (const e of errors) {
      parts.push(`  line ${e.line}: ${e.expr}  —  ${e.message}`);
    }
  }

  const text = parts.join("\n");

  return {
    content: [
      { type: "text" as const, text },
      {
        type: "text" as const,
        text: JSON.stringify({ results, variables, errors, seed }),
      },
    ],
  };
}
