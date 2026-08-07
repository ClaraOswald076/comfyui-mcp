import { beforeEach, describe, expect, it, vi } from "vitest";

const listExtraPathsMock = vi.fn();
const addExtraPathMock = vi.fn();
const removeExtraPathMock = vi.fn();

vi.mock("../../services/extra-paths.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/extra-paths.js")>(
    "../../services/extra-paths.js",
  );
  return {
    ...actual,
    listExtraPaths: (...a: unknown[]) => listExtraPathsMock(...a),
    addExtraPath: (...a: unknown[]) => addExtraPathMock(...a),
    removeExtraPath: (...a: unknown[]) => removeExtraPathMock(...a),
  };
});

import {
  addExtraPathAction,
  listExtraPathsAction,
  removeExtraPathAction,
} from "../../tools/extra-paths.js";

beforeEach(() => {
  listExtraPathsMock.mockReset();
  addExtraPathMock.mockReset();
  removeExtraPathMock.mockReset();
});

/**
 * 0.50.0 slice 11 retired the three extra-path TOOLS into actions of
 * `list_local_models`. What this file still owns is the argument mapping —
 * snake_case tool arguments onto the service's camelCase options — because that
 * mapping is what decides WHICH FILE gets written and with what. Dispatch (which
 * action reaches which of these) is covered in models-consolidated.test.ts.
 */
describe("extra-path actions map snake_case args onto service options", () => {
  it('list_paths passes target + config_path through and returns the JSON view', async () => {
    listExtraPathsMock.mockResolvedValueOnce({ target: "standalone", path: "x", groups: [] });
    const list = await listExtraPathsAction({ target: "standalone", config_path: "x" });
    expect(listExtraPathsMock).toHaveBeenCalledWith({
      target: "standalone",
      configPath: "x",
    });
    expect(JSON.parse(list.content![0].text as string)).toMatchObject({ target: "standalone" });
  });

  it("add_path passes every option, including is_default → isDefault", async () => {
    addExtraPathMock.mockResolvedValueOnce({ changed: true });
    await addExtraPathAction({
      target: "desktop",
      config_path: "y",
      group: "shared",
      category: "custom_nodes",
      path: "D:/Comfy/custom_nodes",
      is_default: true,
    });
    expect(addExtraPathMock).toHaveBeenCalledWith({
      target: "desktop",
      configPath: "y",
      group: "shared",
      category: "custom_nodes",
      path: "D:/Comfy/custom_nodes",
      isDefault: true,
    });
  });

  it("remove_path leaves the untouched options undefined rather than defaulting them", async () => {
    removeExtraPathMock.mockResolvedValueOnce({ changed: true });
    await removeExtraPathAction({
      category: "loras",
      path: "D:/Models/loras",
    });
    expect(removeExtraPathMock).toHaveBeenCalledWith({
      target: undefined,
      configPath: undefined,
      group: undefined,
      category: "loras",
      path: "D:/Models/loras",
    });
  });
});
