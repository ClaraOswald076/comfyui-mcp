import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errorToToolResult } from "../utils/errors.js";
import {
  applyKitchenRecommendation,
  assessKitchen,
  assessKitchenGraph,
  extractLoaders,
  gatherKitchenStatus,
  kitchenProactiveHint,
  type KitchenRecommendation,
  type KitchenStatus,
} from "../services/kitchen.js";
import { isApiFormat, isUiFormat } from "../services/workflow-converter.js";

const ACTIONS = ["status", "assess", "apply"] as const;

function json(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function parseGraph(raw: unknown): unknown {
  if (raw == null) return undefined;
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    return JSON.parse(trimmed);
  }
  if (typeof raw === "object") return raw;
  return undefined;
}

function graphKind(graph: unknown): "api" | "ui" | "nodes" | "unknown" {
  if (isApiFormat(graph)) return "api";
  if (isUiFormat(graph)) return "ui";
  if (graph && typeof graph === "object" && Array.isArray((graph as { nodes?: unknown }).nodes)) {
    return "nodes";
  }
  return "unknown";
}

export async function kitchenStatusAction(): Promise<{
  status: KitchenStatus;
  hint?: string;
}> {
  const status = await gatherKitchenStatus();
  const hint = kitchenProactiveHint(status, assessKitchen(status, {}));
  return hint ? { status, hint } : { status };
}

export async function kitchenAssessAction(args: {
  workflow?: unknown;
}): Promise<{
  status: KitchenStatus;
  loaders: ReturnType<typeof extractLoaders>;
  recommendations: KitchenRecommendation[];
  hint?: string;
  graph_kind: string;
  note?: string;
}> {
  const status = await gatherKitchenStatus();
  const graph = parseGraph(args.workflow);
  if (graph === undefined) {
    return {
      status,
      loaders: [],
      recommendations: [],
      graph_kind: "none",
      note: 'assess needs a workflow JSON (`workflow`). For the open canvas use panel_kitchen with action:"assess".',
    };
  }
  const recommendations = await assessKitchenGraph(status, graph);
  const hint = kitchenProactiveHint(status, recommendations);
  return {
    status,
    loaders: extractLoaders(graph),
    recommendations,
    graph_kind: graphKind(graph),
    ...(hint ? { hint } : {}),
  };
}

export async function kitchenApplyAction(args: {
  recommendation_id?: string;
  workflow?: unknown;
  confirm?: boolean;
}): Promise<unknown> {
  if (!args.recommendation_id) {
    throw new Error('action:"apply" needs recommendation_id from a prior assess.');
  }
  const status = await gatherKitchenStatus();
  const graph = parseGraph(args.workflow);
  const recs = graph !== undefined ? await assessKitchenGraph(status, graph) : [];
  const rec = recs.find((r) => r.id === args.recommendation_id);
  if (!rec) {
    return {
      applied: false,
      error: `No recommendation "${args.recommendation_id}" in this assess. Call kitchen action:"assess" with the same workflow first.`,
      recommendations: recs.map((r) => r.id),
    };
  }
  if (rec.change.type === "widget" && rec.node_id && rec.change.widget && rec.change.value !== undefined && graph) {
    const result = await applyKitchenRecommendation({
      rec,
      confirm: args.confirm,
      applyWidget: async (nodeId, widget, value) => {
        applyWidgetOnGraph(graph, nodeId, widget, value);
        return { node_id: nodeId, widget, value };
      },
    });
    return { ...result, workflow: graph };
  }
  return applyKitchenRecommendation({ rec, confirm: args.confirm });
}

function applyWidgetOnGraph(graph: unknown, nodeId: string, widget: string, value: string): void {
  if (isApiFormat(graph) && graph[nodeId]) {
    graph[nodeId]!.inputs[widget] = value;
    return;
  }
  const nodes = isUiFormat(graph)
    ? graph.nodes
    : Array.isArray((graph as { nodes?: unknown })?.nodes)
      ? ((graph as { nodes: Array<Record<string, unknown>> }).nodes)
      : undefined;
  if (!nodes) return;
  const node = nodes.find((n) => String((n as { id?: unknown }).id) === nodeId) as
    | Record<string, unknown>
    | undefined;
  if (!node) return;
  const captured = node.capturedWidgetValues;
  if (captured && typeof captured === "object" && !Array.isArray(captured)) {
    (captured as Record<string, unknown>)[widget] = value;
  }
  const inputs = node.inputs;
  if (inputs && typeof inputs === "object" && !Array.isArray(inputs)) {
    (inputs as Record<string, unknown>)[widget] = value;
  }
}

export function registerKitchenTools(server: McpServer): void {
  server.tool(
    "kitchen",
    "See what comfy-kitchen can do on this GPU, find where a graph is leaving it on the table, and apply the faster path. Driven by `action`:\n" +
      '- action:"status" — kitchen version, backends (hip/cuda/triton/eager), INT8 attention, GPU fp8/NVFP4/MXFP8, launch flags (--use-ck-attention, --enable-triton-backend, --fast fp8_matrix_mult). Local gets log + /system_stats + an import probe when COMFYUI_PATH is set; remote gets log + /system_stats only and reports model.quant / the probe as unknown. A failed probe is unknown, never a no.\n' +
      '- action:"assess" — walk the workflow JSON\'s UNETLoaders and emit a recommendation only when every fact it needs is known: (1) weight_dtype default on a bf16 UNETLoader + GPU fp8 + kitchen present → fp8_e4m3fn_fast (widget, no restart); (2) no --use-sage-attention, sageattention not installed, kitchen INT8 available → --use-ck-attention (restart, confirm); (3) Blackwell + local NVFP4 sibling → model swap; (4) ROCm + triton ≥ 3.7 + kitchen, triton backend off → --enable-triton-backend. Pass `workflow` (API or UI JSON). For the open canvas use panel_kitchen.\n' +
      '- action:"apply" — apply one recommendation_id from assess. Widget edits are reversible and do not need confirm. Flags and downloads need `confirm: true`. Flag apply names the launch flag; restart_comfyui replays the previous argv and does not inject a new one. Proof (before/after s/it, peak VRAM, output not black) is the panel_kitchen apply path.',
    {
      action: z
        .enum(ACTIONS)
        .describe(
          'Which kitchen operation. "status" takes no other parameters; "assess" takes `workflow`; "apply" takes `recommendation_id` and `confirm` for restarts/downloads.',
        ),
      workflow: z
        .union([z.string(), z.record(z.string(), z.unknown())])
        .optional()
        .describe(
          'action:"assess" / "apply" — workflow JSON (API-format {id:{class_type,inputs}} or UI-format {nodes,links}), as a string or object.',
        ),
      recommendation_id: z
        .string()
        .optional()
        .describe('action:"apply" — id from assess (e.g. "fp8_unet_fast:12" or "ck_attention").'),
      confirm: z
        .boolean()
        .optional()
        .describe(
          'action:"apply" — required true for anything that restarts or downloads. Widget edits do not need it.',
        ),
    },
    async (args) => {
      try {
        switch (args.action) {
          case "status":
            return json(await kitchenStatusAction());
          case "assess":
            return json(await kitchenAssessAction({ workflow: args.workflow }));
          case "apply":
            return json(
              await kitchenApplyAction({
                recommendation_id: args.recommendation_id,
                workflow: args.workflow,
                confirm: args.confirm,
              }),
            );
          default: {
            const exhaustive: never = args.action;
            throw new Error(
              `Unknown kitchen action "${String(exhaustive)}". Expected one of: ${ACTIONS.join(", ")}.`,
            );
          }
        }
      } catch (err) {
        return errorToToolResult(err);
      }
    },
  );
}
