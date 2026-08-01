import { describe, expect, it } from "vitest";
import { z } from "zod";
import { listRegisteredTools } from "../../tools/introspect.js";
import { registerAllTools } from "../../tools/index.js";

/**
 * The published Tool Reference must describe the schema a CLIENT is actually given.
 *
 * scripts/gen-tool-docs.ts converts each zod shape itself rather than reading the
 * real `tools/list` output, so its conversion options have to match the SDK's. They
 * did not: the SDK passes `io: 'input'`
 * (sdk/server/zod-json-schema-compat.js) and the generator passed nothing, which
 * means OUTPUT semantics — where a field with `.default()` is always present and so
 * counts as required.
 *
 * The result was 25 parameters across 18 tools documented as REQUIRED while the real
 * schema said optional (`comfy_cli_status.detail` is declared
 * `.optional().default("env")` and rendered `required default="env"`). A human
 * supplying every "required" field does needless work; a model reading it may refuse
 * to call the tool at all. And the docs-freshness gate stayed green the whole time,
 * because regenerating reproduced the same wrong answer — a generated artefact is
 * only as trustworthy as its agreement with the thing it claims to describe.
 *
 * This asserts that agreement directly, so the two can never drift apart again.
 */
describe("generated docs match the client-visible schema", () => {
  it("agrees with tools/list on which parameters are required", async () => {
    // Replicates the generator's conversion exactly — including its options, which is
    // the thing under test.
    const generated = (shape: z.ZodRawShape) =>
      z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
        required?: string[];
      };

    const captured: Array<{ name: string; shape: z.ZodRawShape }> = [];
    const mock = {
      tool(name: string, a?: unknown, b?: unknown) {
        if (typeof a === "string" && b && typeof b === "object") {
          captured.push({ name, shape: b as z.ZodRawShape });
        } else if (a && typeof a === "object") {
          captured.push({ name, shape: a as z.ZodRawShape });
        } else {
          captured.push({ name, shape: {} });
        }
        return { update() {}, remove() {}, enable() {}, disable() {} };
      },
    };
    await registerAllTools(mock as never);

    const live = await listRegisteredTools();
    const liveRequired = new Map(
      live.map((t) => [
        t.name,
        new Set((t.inputSchema as { required?: string[] }).required ?? []),
      ]),
    );

    const divergences: string[] = [];
    for (const { name, shape } of captured) {
      const expectedSet = liveRequired.get(name);
      if (!expectedSet) continue; // autoloaded/dynamic tools are not documented
      const got = new Set(generated(shape).required ?? []);
      const docsOnly = [...got].filter((k) => !expectedSet.has(k));
      const clientOnly = [...expectedSet].filter((k) => !got.has(k));
      if (docsOnly.length || clientOnly.length) {
        divergences.push(
          `${name}: documented-required-but-optional=[${docsOnly.join(", ")}] ` +
            `required-but-undocumented=[${clientOnly.join(", ")}]`,
        );
      }
    }

    expect(
      divergences,
      "scripts/gen-tool-docs.ts and the real tools/list schema disagree. Align the " +
        "generator's z.toJSONSchema options with the SDK's (io: 'input').",
    ).toEqual([]);
  });
});
