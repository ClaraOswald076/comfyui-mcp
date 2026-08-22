import { afterEach, describe, expect, it } from "vitest";

import {
  advertisedPublicOrigin,
  advertisedWebSocketOrigin,
  configuredPublicOrigin,
  localComfyuiPort,
  runpodPodId,
} from "../../services/advertised-origin.js";

const OLD_POD = process.env.RUNPOD_POD_ID;
const OLD_PUBLIC = process.env.COMFYUI_MCP_PUBLIC_URL;

afterEach(() => {
  if (OLD_POD === undefined) delete process.env.RUNPOD_POD_ID;
  else process.env.RUNPOD_POD_ID = OLD_POD;
  if (OLD_PUBLIC === undefined) delete process.env.COMFYUI_MCP_PUBLIC_URL;
  else process.env.COMFYUI_MCP_PUBLIC_URL = OLD_PUBLIC;
});

describe("advertised public origins", () => {
  it("derives the RunPod proxy per exposed listener port", () => {
    process.env.RUNPOD_POD_ID = "abc-123";
    delete process.env.COMFYUI_MCP_PUBLIC_URL;

    expect(runpodPodId()).toBe("abc-123");
    expect(localComfyuiPort()).toBe(3001);
    expect(advertisedPublicOrigin(9180)).toBe("https://abc-123-9180.proxy.runpod.net");
    expect(advertisedWebSocketOrigin(9180)).toBe("wss://abc-123-9180.proxy.runpod.net");
  });

  it("uses the explicit public origin ahead of RunPod inference", () => {
    process.env.RUNPOD_POD_ID = "abc-123";
    process.env.COMFYUI_MCP_PUBLIC_URL = "https://mcp.example.test/ignored-path";

    expect(configuredPublicOrigin()).toBe("https://mcp.example.test");
    expect(advertisedPublicOrigin(9180)).toBe("https://mcp.example.test");
    expect(advertisedWebSocketOrigin(9180)).toBe("wss://mcp.example.test");
  });

  it("fails closed for malformed or credential-bearing overrides", () => {
    process.env.RUNPOD_POD_ID = "bad/pod";
    process.env.COMFYUI_MCP_PUBLIC_URL = "https://user:secret@example.test/?token=leak";

    expect(runpodPodId()).toBeUndefined();
    expect(configuredPublicOrigin()).toBeUndefined();
    expect(advertisedPublicOrigin(9180)).toBeUndefined();
  });
});
