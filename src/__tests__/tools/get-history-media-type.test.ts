import { beforeEach, describe, expect, it, vi } from "vitest";

// #554: get_history summarized media filenames but DROPPED each ref's ComfyUI
// directory type. A PixaromaCompare (and other preview/compare) node writes its
// outputs to temp/, not output/ — so following the documented
// get_image(type:"output") call 404'd, while type:"temp" succeeded. The summary
// must carry the type so the caller fetches the media reliably in one shot.

const getHistoryMock = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getLogs: vi.fn(),
  getHistory: (...a: unknown[]) => getHistoryMock(...a),
}));

import { registerDiagnosticsTools } from "../../tools/diagnostics.js";

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
  registerDiagnosticsTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

beforeEach(() => getHistoryMock.mockReset());

describe("get_history media type (#554)", () => {
  it("includes each media ref's ComfyUI directory type (temp) so get_image gets the right type", async () => {
    getHistoryMock.mockResolvedValue({
      "p-temp": {
        prompt: [1, "p-temp", {}, {}, []],
        status: { status_str: "success", completed: true, messages: [] },
        outputs: {
          "7091": {
            images: [
              { filename: "pixaroma_compare_00001_.png", subfolder: "", type: "temp" },
            ],
          },
        },
      },
    });

    const out = await getHandler("get_history")({ prompt_id: "p-temp" });
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("pixaroma_compare_00001_.png");
    // The actionable bit: the type must be present so the caller does NOT default
    // to type:"output" and 404.
    expect(text).toContain("type=temp");
    expect(text).not.toContain("type=output");
  });

  it("defaults an unspecified type to output and preserves the subfolder", async () => {
    getHistoryMock.mockResolvedValue({
      "p-out": {
        prompt: [2, "p-out", {}, {}, []],
        status: { status_str: "success", completed: true, messages: [] },
        outputs: {
          "9": {
            images: [{ filename: "ComfyUI_00007_.png", subfolder: "renders" }],
            videos: [{ filename: "clip.mp4", subfolder: "", type: "output" }],
          },
        },
      },
    });

    const out = await getHandler("get_history")({ prompt_id: "p-out" });
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).toContain("renders/ComfyUI_00007_.png (type=output)");
    expect(text).toContain("clip.mp4 (type=output)");
  });
});
