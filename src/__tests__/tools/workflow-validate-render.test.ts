import { describe, expect, it, beforeEach, vi } from "vitest";

// Render-layer regression for #342 / #505: the tool must DERIVE its "ready to
// execute" verdict from the surfaced errors and must NOT mask authoritative
// combo/enum/model errors (which carry `kind`) behind "No issues found".
const validateWorkflowMock = vi.fn();
vi.mock("../../services/workflow-validator.js", () => ({
  validateWorkflow: (...a: unknown[]) => validateWorkflowMock(...a),
}));

import { registerWorkflowValidateTools } from "../../tools/workflow-validate.js";
import type { ValidationResult } from "../../services/workflow-validator.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  registerWorkflowValidateTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

const run = async (result: ValidationResult): Promise<string> => {
  validateWorkflowMock.mockResolvedValue(result);
  const handler = getHandler("validate_workflow");
  const out = await handler({ workflow: { "1": { class_type: "SaveImage", inputs: {} } } });
  return out.content.map((c) => c.text).join("\n");
};

beforeEach(() => {
  validateWorkflowMock.mockReset();
});

describe("validate_workflow render — verdict is derived from errors (#342)", () => {
  it("never says 'ready to execute' when the result is invalid with a real error", async () => {
    const text = await run({
      valid: false,
      summary: "Workflow has 1 error(s) and 0 warning(s)",
      issues: [
        {
          severity: "error",
          node_id: "1",
          node_type: "KSampler",
          message: "Missing required input \"model\"",
        },
      ],
    });
    expect(text).toContain("Workflow has 1 error(s)");
    expect(text).not.toContain("ready to execute");
    // The error itself must be listed, not hidden.
    expect(text).toContain("### Errors");
    expect(text).toContain('Missing required input "model"');
  });

  it("a genuinely-valid workflow says ready to execute with no error section", async () => {
    const text = await run({
      valid: true,
      summary: "Workflow is valid",
      issues: [],
    });
    expect(text).toContain("ready to execute");
    expect(text).not.toContain("### Errors");
  });
});

describe("validate_workflow render — authoritative combo errors are surfaced (#505)", () => {
  it("surfaces a value_not_in_list combo error (which carries `kind`) in the Errors section", async () => {
    const text = await run({
      valid: false,
      summary: "Workflow has 1 error(s) and 0 warning(s)",
      issues: [
        {
          severity: "error",
          node_id: "1",
          node_type: "CLIPLoader",
          kind: "value_not_in_list",
          input: "type",
          value: "gemma",
          message: '"type" = "gemma" is not in the list of valid options (value_not_in_list).',
        },
      ],
    });
    expect(text).toContain("### Errors");
    expect(text).toContain("value_not_in_list");
    // Must NOT be masked behind the "No issues found" summary.
    expect(text).not.toContain("No issues found");
    expect(text).not.toContain("ready to execute");
  });

  it("surfaces a missing_model error (carries `kind`) rather than claiming no issues", async () => {
    const text = await run({
      valid: false,
      summary: "Workflow has 1 error(s) and 0 warning(s)",
      issues: [
        {
          severity: "error",
          node_id: "2",
          node_type: "UNETLoader",
          kind: "missing_model",
          input: "unet_name",
          value: "missing.gguf",
          message: '"unet_name" = "missing.gguf" is not in the list of valid options.',
        },
      ],
    });
    expect(text).toContain("missing.gguf");
    expect(text).not.toContain("No issues found");
  });

  it("keeps graph-health findings (health:true) out of Errors but still shows the health section", async () => {
    const text = await run({
      valid: true,
      summary: "Workflow is valid",
      issues: [
        {
          severity: "info",
          node_id: "3",
          node_type: "LoadImage",
          kind: "disconnected",
          health: true,
          message: "Node 3 is disconnected from any output",
        },
      ],
      health: {
        summary: "1 heuristic finding",
        findings: [
          {
            severity: "info",
            kind: "disconnected",
            heuristic: true,
            detail: "Node 3 is disconnected from any output",
            node_ids: ["3"],
            node_type: "LoadImage",
          },
        ],
      } as never,
    });
    // Health issue is NOT surfaced as an error, and the valid verdict holds.
    expect(text).not.toContain("### Errors");
    expect(text).toContain("ready to execute");
    expect(text).toContain("### Graph health");
  });
});
