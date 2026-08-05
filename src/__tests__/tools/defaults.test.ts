import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ComfyUIError } from "../../utils/errors.js";
import { DEAD_NAMES, TOOL_NAMES } from "../../tools/vocabulary.js";

/**
 * The consolidated `get_defaults` tool (0.50.0 slice 7): the two
 * generation-defaults tools and the two ComfyUI UI-settings tools folded into
 * one action-parameterized tool. Proves the consolidation did not change
 * behaviour — every action calls the identical function the old tool called,
 * with the same arguments and the same content block — and that the flat-enum
 * shape actually EXPOSES its parameters (the discriminated-union trap renders
 * zero params).
 *
 * THE DEFECT THIS FILE EXISTS FOR. This fold puts TWO UNRELATED STORES behind
 * one name: action:"get"/"set" are the MCP server's own generation defaults,
 * action:"get_ui"/"set_ui" are ComfyUI's frontend `Comfy.*` settings served over
 * HTTP. Nothing enforces that they stay apart except the switch, and crossing
 * them is a wrong ANSWER — a caller asking to loosen ComfyUI's workflow
 * validation would instead write a `Comfy.Validation.Workflows` key into our
 * generation defaults, where nothing reads it, and be told it worked. The
 * store-separation tests below assert each action touches ONE store and leaves
 * the other untouched.
 */

const mocks = vi.hoisted(() => ({
  getAll: vi.fn(),
  getConfigPath: vi.fn(),
  set: vi.fn(),
  getSettings: vi.fn(),
  getSetting: vi.fn(),
  setSetting: vi.fn(),
}));

vi.mock("../../services/defaults-manager.js", () => ({
  DefaultsManager: {
    getAll: (...args: unknown[]) => mocks.getAll(...args),
    getConfigPath: (...args: unknown[]) => mocks.getConfigPath(...args),
    set: (...args: unknown[]) => mocks.set(...args),
  },
}));

vi.mock("../../comfyui/client.js", () => ({
  getSettings: (...args: unknown[]) => mocks.getSettings(...args),
  getSetting: (...args: unknown[]) => mocks.getSetting(...args),
  setSetting: (...args: unknown[]) => mocks.setSetting(...args),
}));

import { registerDefaultsTools } from "../../tools/defaults.js";

type Handler = (args: Record<string, any>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

interface Registered {
  name: string;
  shape: z.ZodRawShape;
  handler: Handler;
}

function registered(): Registered[] {
  const tools: Registered[] = [];
  const server = {
    tool: (name: string, _desc: string, shape: z.ZodRawShape, handler: Handler) => {
      tools.push({ name, shape, handler });
    },
  };
  registerDefaultsTools(server as never);
  return tools;
}

/** Both defaults surfaces are now ONE tool (0.50.0 slice 7). */
function handler(): Handler {
  const tools = registered();
  expect(tools).toHaveLength(1);
  expect(tools[0].name).toBe("get_defaults");
  return tools[0].handler;
}

const text = (res: Awaited<ReturnType<Handler>>) => res.content.map((c) => c.text).join(" ");

/** Everything that writes OUR generation-defaults store. */
const ourStoreWrites = () => [mocks.set];
/** Everything that reads or writes COMFYUI's frontend settings store. */
const comfyStore = () => [mocks.getSettings, mocks.getSetting, mocks.setSetting];

beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.getAll.mockReturnValue({ width: 1024 });
  mocks.getConfigPath.mockReturnValue("/cfg/config.json");
});

describe("get_defaults registration", () => {
  it("registers exactly one tool named `get_defaults` (4→1)", () => {
    const tools = registered();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("get_defaults");
  });

  // The whole reason for the flat-enum shape rule: a z.discriminatedUnion renders
  // as ZERO parameters, hiding every input from the model.
  it("exposes a visible flat `action` enum with every per-action parameter", () => {
    const [{ shape }] = registered();
    // io: "input" — the conversion options the MCP SDK itself uses
    // (sdk/server/zod-json-schema-compat.js, asserted by docs-schema-parity.test.ts),
    // so this is the schema a client is actually given.
    const json = z.toJSONSchema(z.object(shape), { reused: "inline", io: "input" }) as {
      properties?: Record<string, { enum?: string[] }>;
      required?: string[];
    };
    expect(Object.keys(json.properties ?? {}).sort()).toEqual([
      "action",
      "filter",
      "id",
      "persist",
      "value",
      "values",
    ]);
    expect(json.properties?.action.enum?.slice().sort()).toEqual([
      "get",
      "get_ui",
      "set",
      "set_ui",
    ]);
    // Only `action` can be required — the rest are per-action, enforced in the handler.
    expect(json.required).toEqual(["action"]);
  });

  // `_ui` is the ONLY thing distinguishing the two stores in the action names, so
  // the description has to say which is which rather than leaving a model to infer
  // it from a suffix.
  it("the description states plainly that these are two separate stores", () => {
    const server = { tool: vi.fn() };
    registerDefaultsTools(server as never);
    const description = server.tool.mock.calls[0][1] as string;
    expect(description).toMatch(/two SEPARATE stores/i);
    expect(description).toMatch(/action:"get_ui"[\s\S]*DIFFERENT store/);
    expect(description).toMatch(/action:"set_ui"[\s\S]*NOT our generation defaults/);
  });

  it("an unknown action returns a clear error result", async () => {
    const res = await handler()({ action: "bogus" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unknown get_defaults action/i);
    expect(text(res)).toMatch(/get, set, get_ui, set_ui/);
    for (const mock of [...ourStoreWrites(), ...comfyStore()]) {
      expect(mock).not.toHaveBeenCalled();
    }
  });
});

describe("the generation-defaults actions (OUR store)", () => {
  it('action:"get" returns config_path + the merged defaults, exactly as before', async () => {
    const res = await handler()({ action: "get" });
    expect(JSON.parse(text(res))).toEqual({
      config_path: "/cfg/config.json",
      defaults: { width: 1024 },
    });
  });

  it('action:"set" forwards values + persist and reports the runtime/config status', async () => {
    const res = await handler()({ action: "set", values: { steps: 30 }, persist: true });
    expect(mocks.set).toHaveBeenCalledWith({ steps: 30 }, { persist: true });
    expect(JSON.parse(text(res))).toEqual({
      status: "updated_runtime_and_config",
      config_path: "/cfg/config.json",
      defaults: { width: 1024 },
    });
  });

  it('action:"set" without persist reports runtime only, as before', async () => {
    const res = await handler()({ action: "set", values: { steps: 30 } });
    expect(mocks.set).toHaveBeenCalledWith({ steps: 30 }, { persist: undefined });
    expect(JSON.parse(text(res)).status).toBe("updated_runtime");
  });
});

describe("the ComfyUI UI-settings actions (COMFYUI's store)", () => {
  it('action:"get_ui" with an id returns that one setting\'s raw stored value', async () => {
    mocks.getSetting.mockResolvedValueOnce(false);
    const res = await handler()({ action: "get_ui", id: "Comfy.Validation.Workflows" });
    expect(mocks.getSetting).toHaveBeenCalledWith("Comfy.Validation.Workflows");
    expect(JSON.parse(text(res))).toEqual({ id: "Comfy.Validation.Workflows", value: false });
  });

  // An unset key is not the same as a key set to null, and the note is the only
  // thing that tells a caller which one they are looking at.
  it('action:"get_ui" reports an unset id as null plus the frontend-default note', async () => {
    mocks.getSetting.mockResolvedValueOnce(undefined);
    const res = await handler()({ action: "get_ui", id: "Comfy.Nope" });
    expect(JSON.parse(text(res))).toEqual({
      id: "Comfy.Nope",
      value: null,
      note: "unset (frontend default applies)",
    });
  });

  it('action:"get_ui" without an id lists all stored settings, sorted and filtered', async () => {
    mocks.getSettings.mockResolvedValueOnce({
      "Comfy.PreviewMethod": "auto",
      "Comfy.UseNewMenu": "Top",
      "Comfy.LinkRenderMode": 2,
    });
    const res = await handler()({ action: "get_ui", filter: "preview" });
    expect(mocks.getSettings).toHaveBeenCalled();
    const payload = JSON.parse(text(res));
    expect(payload.count).toBe(1);
    expect(payload.settings).toEqual({ "Comfy.PreviewMethod": "auto" });
    expect(payload.note).toMatch(/unset ids use frontend defaults/);
  });

  it('action:"set_ui" reads the previous value first, then writes, and returns both', async () => {
    mocks.getSetting.mockResolvedValueOnce(true);
    const res = await handler()({
      action: "set_ui",
      id: "Comfy.Validation.Workflows",
      value: false,
    });
    expect(mocks.getSetting).toHaveBeenCalledWith("Comfy.Validation.Workflows");
    expect(mocks.setSetting).toHaveBeenCalledWith("Comfy.Validation.Workflows", false);
    expect(JSON.parse(text(res))).toEqual({
      id: "Comfy.Validation.Workflows",
      previous: true,
      value: false,
    });
  });

  it('action:"set_ui" reports previous:null when the key was unset', async () => {
    mocks.getSetting.mockResolvedValueOnce(undefined);
    const res = await handler()({ action: "set_ui", id: "Comfy.Nope", value: 2 });
    expect(JSON.parse(text(res)).previous).toBeNull();
  });

  // Carried over from the retired comfyui-settings.test.ts: the error PATH is
  // part of the behaviour this consolidation promised not to change. A
  // ComfyUIError must still arrive as its structured payload with the code
  // intact, not be flattened into prose by the new dispatch layer.
  it("surfaces a friendly version-drift error on 404, with its code", async () => {
    mocks.getSettings.mockRejectedValueOnce(
      new ComfyUIError(
        "This ComfyUI version/config does not expose the user settings API",
        "SETTINGS_UNSUPPORTED",
      ),
    );
    const res = await handler()({ action: "get_ui" });
    expect(res.isError).toBe(true);
    const payload = JSON.parse(text(res)) as { error: string; message: string };
    expect(payload.error).toBe("SETTINGS_UNSUPPORTED");
    expect(payload.message).toContain("user settings API");
  });

  it("refuses in cloud mode (CLOUD_UNSUPPORTED), unchanged", async () => {
    mocks.getSetting.mockRejectedValueOnce(
      new ComfyUIError("needs a direct ComfyUI session (settings)", "CLOUD_UNSUPPORTED"),
    );
    const res = await handler()({ action: "set_ui", id: "Comfy.UseNewMenu", value: "Top" });
    expect(res.isError).toBe(true);
    expect((JSON.parse(text(res)) as { error: string }).error).toBe("CLOUD_UNSUPPORTED");
    // The write must not have happened — the previous-value read threw first.
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });
});

// The failure mode this fold introduces and nothing else would catch.
describe("the two stores stay separate", () => {
  it('action:"set" writes OUR defaults and never touches ComfyUI\'s settings', async () => {
    await handler()({ action: "set", values: { "Comfy.Validation.Workflows": false } });
    expect(mocks.set).toHaveBeenCalled();
    for (const mock of comfyStore()) expect(mock).not.toHaveBeenCalled();
  });

  it('action:"set_ui" writes COMFYUI\'s settings and never touches our defaults', async () => {
    mocks.getSetting.mockResolvedValueOnce(undefined);
    await handler()({ action: "set_ui", id: "Comfy.PreviewMethod", value: "taesd" });
    expect(mocks.setSetting).toHaveBeenCalledWith("Comfy.PreviewMethod", "taesd");
    for (const mock of ourStoreWrites()) expect(mock).not.toHaveBeenCalled();
  });

  it('action:"get" reads OUR defaults without any ComfyUI HTTP call', async () => {
    await handler()({ action: "get" });
    for (const mock of comfyStore()) expect(mock).not.toHaveBeenCalled();
  });

  it('action:"get_ui" reads COMFYUI\'s settings without writing our defaults', async () => {
    mocks.getSettings.mockResolvedValueOnce({});
    await handler()({ action: "get_ui" });
    for (const mock of ourStoreWrites()) expect(mock).not.toHaveBeenCalled();
  });
});

describe("per-action presence guards (the flat shape cannot schema-require these)", () => {
  it('action:"set" without `values` names the field and writes nothing', async () => {
    const res = await handler()({ action: "set" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"set" requires `values`');
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it('action:"set_ui" without `id` names the field and writes nothing', async () => {
    const res = await handler()({ action: "set_ui", value: false });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"set_ui" requires `id`');
    expect(mocks.setSetting).not.toHaveBeenCalled();
  });

  it('action:"set_ui" without `value` names the field and writes nothing', async () => {
    const res = await handler()({ action: "set_ui", id: "Comfy.UseNewMenu" });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('action:"set_ui" requires `value`');
    expect(mocks.setSetting).not.toHaveBeenCalled();
    // The read must not happen either — a refused write should leave no trace.
    expect(mocks.getSetting).not.toHaveBeenCalled();
  });

  // THE FALSINESS TRAP, and it is not hypothetical here. `false`, `0` and `""`
  // are all LEGAL ComfyUI setting values, and `Comfy.Validation.Workflows: false`
  // — loosening validation so a custom-node workflow will load — is the single
  // most common real write this tool performs. A `!value` guard would refuse
  // exactly that call while claiming the field was missing.
  it.each([
    ["false", false],
    ["zero", 0],
    ["the empty string", ""],
  ])('action:"set_ui" accepts %s as a value and writes it through', async (_label, value) => {
    mocks.getSetting.mockResolvedValueOnce(undefined);
    const res = await handler()({ action: "set_ui", id: "Comfy.Validation.Workflows", value });
    expect(res.isError).toBeUndefined();
    expect(mocks.setSetting).toHaveBeenCalledWith("Comfy.Validation.Workflows", value);
    expect(JSON.parse(text(res)).value).toEqual(value);
  });

  // Same rule for the other two guarded fields: absence, never falsiness. Each of
  // these passed its old schema and reached the service, which answers on its own
  // terms — an empty map is a legal no-op set, and an empty id is the server's
  // question to answer, not ours to pre-empt with generic text.
  it('action:"get_ui" with an explicitly empty id still reaches the client, as before', async () => {
    mocks.getSetting.mockResolvedValueOnce(undefined);
    await handler()({ action: "get_ui", id: "" });
    expect(mocks.getSetting).toHaveBeenCalledWith("");
    // …and it must be the SINGLE-id branch, not the list-everything branch.
    expect(mocks.getSettings).not.toHaveBeenCalled();
  });

  it('action:"set_ui" with an explicitly empty id still reaches the client, as before', async () => {
    mocks.getSetting.mockResolvedValueOnce(undefined);
    const res = await handler()({ action: "set_ui", id: "", value: 1 });
    expect(res.isError).toBeUndefined();
    expect(mocks.setSetting).toHaveBeenCalledWith("", 1);
  });

  // `values` gets the same `=== undefined` treatment for consistency, but note
  // the honest difference: an empty OBJECT is truthy in JS, so `!args.values`
  // would behave identically for `{}` and compact.ts zod-validates before the
  // handler, so `null` never arrives. The guard style is a convention here
  // rather than a behavioural fix — unlike `value`, where `false` is both legal
  // and falsy. The assertion below still pins that `{}` is forwarded verbatim
  // rather than being normalised or rejected.
  it("an explicitly empty values map still reaches the defaults manager, as before", async () => {
    await handler()({ action: "set", values: {} });
    expect(mocks.set).toHaveBeenCalledWith({}, { persist: undefined });
  });
});

describe("the three folded names are retired", () => {
  const old = ["set_defaults", "get_comfyui_settings", "set_comfyui_setting"];

  it("each old name is in DEAD_NAMES with a `get_defaults` action replacement", () => {
    for (const name of old) {
      const entry = DEAD_NAMES.find((d) => d.name === name);
      expect(entry, `${name} must be declared dead`).toBeDefined();
      expect(entry!.since).toBe("0.50.0");
      expect(entry!.replacement).toContain("get_defaults");
    }
  });

  // A caller redirected from set_comfyui_setting to action:"set" would silently
  // write the WRONG store, so the redirect has to carry the _ui suffix.
  it("the UI-settings redirects point at the _ui actions, not the defaults ones", () => {
    expect(DEAD_NAMES.find((d) => d.name === "get_comfyui_settings")!.replacement).toContain(
      '"get_ui"',
    );
    expect(DEAD_NAMES.find((d) => d.name === "set_comfyui_setting")!.replacement).toContain(
      '"set_ui"',
    );
    expect(DEAD_NAMES.find((d) => d.name === "set_defaults")!.replacement).toBe(
      'get_defaults (action:"set")',
    );
  });

  it("no old name is still in the live ledger, and `get_defaults` is", () => {
    for (const name of old) expect(TOOL_NAMES as readonly string[]).not.toContain(name);
    expect(TOOL_NAMES as readonly string[]).toContain("get_defaults");
  });
});
