import { beforeEach, describe, expect, it, vi } from "vitest";

const applyManifestMock = vi.fn();

vi.mock("../../services/manifest.js", async () => {
  return {
    manifestSchema: {
      optional: () => ({ describe: () => ({}) }),
    },
    applyManifest: (...a: unknown[]) => applyManifestMock(...a),
  };
});

import { applyManifestAction } from "../../tools/manifest.js";

beforeEach(() => {
  applyManifestMock.mockReset();
});

/**
 * 0.50.0 slice 13 folded this tool into
 * `install_comfyui (action:"apply_manifest")`. The service call and its argument
 * object are unchanged, so this exercises the exported action handler; the
 * dispatch and the schema live in install-environment.test.ts.
 */
describe("the manifest action", () => {
  it("passes inline manifests through and returns structured JSON", async () => {
    applyManifestMock.mockResolvedValueOnce({
      success: true,
      summary: { applied: 1, skipped: 0, failed: 0 },
      results: [
        {
          item: "comfyui-impact-pack",
          action: "custom_node",
          status: "applied",
          message: "installed",
        },
      ],
    });

    const args = { manifest: { custom_nodes: ["comfyui-impact-pack"] } };
    const res = (await applyManifestAction(args)) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };

    expect(applyManifestMock).toHaveBeenCalledWith(args);
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0].text)).toMatchObject({
      success: true,
      summary: { applied: 1 },
    });
  });
});
