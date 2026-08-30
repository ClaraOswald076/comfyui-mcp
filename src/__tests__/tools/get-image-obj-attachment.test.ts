import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchImage: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
}));

// Keep the real getOutputImage and get_image handler in this test. Only the
// /view transport and local save calls are mocked, so this covers the
// production classification path rather than stubbing the service result.
vi.mock("../../comfyui/client.js", async () => {
  const actual = await vi.importActual<typeof import("../../comfyui/client.js")>("../../comfyui/client.js");
  return {
    ...actual,
    fetchImage: (...args: unknown[]) => mocks.fetchImage(...args),
  };
});

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    mkdir: (...args: unknown[]) => mocks.mkdir(...args),
    writeFile: (...args: unknown[]) => mocks.writeFile(...args),
  };
});

import { registerImageManagementTools } from "../../tools/image-management.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
};
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (toolName: string, _description: string, _schema: unknown, toolHandler: ToolHandler) => {
      if (toolName === name) handler = toolHandler;
    },
  };
  registerImageManagementTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.fetchImage.mockResolvedValue({
    // Minimal Wavefront OBJ-shaped text: the body is present, but it is not a
    // format get_image is allowed to save or render.
    base64: Buffer.from("# ComfyUI OBJ output\no Cube\nv 0 0 0\nf 1 1 1\n", "utf8").toString("base64"),
    mimeType: "application/octet-stream",
  });
  mocks.mkdir.mockResolvedValue(undefined);
  mocks.writeFile.mockResolvedValue(undefined);
});

describe("get_image action:get — existing OBJ attachments (#2608)", () => {
  it("does not mistake an existing OBJ attachment for a missing file or save it", async () => {
    const out = await getHandler("get_image")({
      action: "get",
      filename: "mesh.obj",
      type: "output",
      save_dir: "test-fixtures/saved-obj",
    });

    expect(out.isError).toBe(true);
    const payload = JSON.parse(out.content.map((block) => block.text ?? "").join("")) as {
      error?: string;
      message?: string;
    };
    expect(payload.error).toBe("ATTACHMENT_TYPE_UNSUPPORTED");
    expect(payload.message).toContain("existing OBJ attachment");
    expect(payload.message).toContain("get_image cannot save this type");
    expect(payload.message).not.toContain("may not exist");
    expect(mocks.fetchImage).toHaveBeenCalledWith("mesh.obj", "output", "");
    expect(mocks.mkdir).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });
});
