import { describe, expect, it, vi } from "vitest";

// The tool's format:"json" shape is the contract the mobile dataset picker
// builds on — pin it. The service is mocked; the markdown path must stay
// byte-for-byte compatible (default when format is omitted).
const listMock = vi.fn();
vi.mock("../../services/image-management.js", () => ({
  extractWorkflowFromImage: vi.fn(),
  listOutputImages: (...a: unknown[]) => listMock(...a),
  getOutputImage: vi.fn(),
  uploadImageAuto: vi.fn(),
  uploadVideoAuto: vi.fn(),
  uploadAudioAuto: vi.fn(),
  stageOutputAsInput: vi.fn(),
}));

import { registerImageManagementTools } from "../../tools/image-management.js";

type ToolHandler = (args: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
function getHandler(name: string): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = { tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => { if (n === name) handler = h; } };
  registerImageManagementTools(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

const sample = [
  { filename: "a.png", path: "/out/a.png", size: 1024, modified: "2026-07-22T00:00:00.000Z", subfolder: "", kind: "image" },
  { filename: "b.mp4", path: "/out/video/b.mp4", size: 2048, modified: "2026-07-21T00:00:00.000Z", subfolder: "video", kind: "video" },
];

describe("list_output_images format param", () => {
  it("default (markdown) keeps the human/agent-readable list", async () => {
    listMock.mockResolvedValue(sample);
    const t = (await getHandler("list_output_images")({ limit: 5 })).content[0].text;
    expect(t).toContain("Found 2 media file(s) (1 video):");
    expect(t).toContain("**video/b.mp4** [video]");
  });

  it("format:json returns a machine-readable array (no prose)", async () => {
    listMock.mockResolvedValue(sample);
    const t = (await getHandler("list_output_images")({ limit: 5, format: "json" })).content[0].text;
    const parsed = JSON.parse(t) as { images: Array<Record<string, unknown>> };
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images[0]).toEqual({ filename: "a.png", subfolder: "", kind: "image", size: 1024, modified: "2026-07-22T00:00:00.000Z" });
    expect(parsed.images[1]).toMatchObject({ filename: "b.mp4", subfolder: "video", kind: "video" });
  });

  it("format:json with no matches returns an empty array (not a prose message)", async () => {
    listMock.mockResolvedValue([]);
    const t = (await getHandler("list_output_images")({ format: "json" })).content[0].text;
    expect(JSON.parse(t)).toEqual({ images: [] });
  });

  it("format:json omits size/modified when the scan can't provide them (remote/history path)", async () => {
    listMock.mockResolvedValue([{ filename: "r.png", path: "", size: 0, modified: "", subfolder: "", kind: "image" }]);
    const t = (await getHandler("list_output_images")({ format: "json" })).content[0].text;
    const parsed = JSON.parse(t) as { images: Array<Record<string, unknown>> };
    expect(parsed.images[0]).toEqual({ filename: "r.png", subfolder: "", kind: "image" });
  });
});
