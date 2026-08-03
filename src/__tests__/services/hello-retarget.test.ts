import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { judgeHelloRetarget, canonComfyuiTargetUrl } from "../../services/hello-retarget.js";

// #756 (local ComfyUI misclassified as remote after a restart) + the #303
// zombie-tab guard the veto exists for. The /system_stats probe is injected,
// so "unreachable" is simulated by a probe that resolves false — no real I/O,
// no timing dependence.

/** A probe that answers true only for the listed reachable base URLs. */
function probeFor(...reachableBases: string[]) {
  const reachable = new Set(reachableBases.map((b) => `${b.replace(/\/+$/, "")}/system_stats`));
  return vi.fn(async (systemStatsUrl: string) => reachable.has(systemStatsUrl));
}

describe("judgeHelloRetarget (#756 restart window)", () => {
  it("APPLIES a local hello that races the ComfyUI restart window when the current (stale remote) target is dead too", async () => {
    // The orchestrator is pinned to a stale RunPod target; the local panel
    // reconnects while the local ComfyUI is still booting — BOTH probes read
    // dead. Pre-#756 the veto dropped this hello and pinned remote forever.
    const probe = probeFor(); // nothing answers — the restart window
    const verdict = await judgeHelloRetarget({
      helloUrl: "http://127.0.0.1:8188",
      currentUrl: "https://abc123-3000.proxy.runpod.net",
      probe,
    });
    expect(verdict.apply).toBe(true);
    expect(verdict.reason).toBe("current-also-unreachable");
    expect(verdict.base).toBe("http://127.0.0.1:8188");
    // Both sides were probed before deciding.
    expect(probe).toHaveBeenCalledWith("http://127.0.0.1:8188/system_stats");
    expect(probe).toHaveBeenCalledWith("https://abc123-3000.proxy.runpod.net/system_stats");
  });

  it("restart → reconnect → local ref resolution + Manager probing recover (composed with the real config)", async () => {
    // Boot the shared config ON a stale pod target (remote), then apply the
    // hello verdict through the same setComfyuiTarget the orchestrator calls:
    // the classification must return to LOCAL and the base URL every tool
    // (train refs, Manager v4 queue probing) derives must be the local one.
    vi.resetModules();
    const OLD_ENV = process.env;
    process.env = { ...OLD_ENV };
    try {
      const fakeHome = mkdtempSync(join(tmpdir(), "hello-retarget-home-"));
      process.env.COMFYUI_MCP_LOCAL_TARGET_FILE = join(fakeHome, "local-target.json");
      process.env.COMFYUI_API_KEY = "";
      process.env.COMFYUI_PATH = "";
      process.env.COMFYUI_HOST = "";
      process.env.COMFYUI_PORT = "8188";
      process.env.COMFYUI_MCP_FORCE_REMOTE = "";
      process.env.COMFYUI_URL = "https://abc123-3000.proxy.runpod.net";
      const mod = await import("../../config.js");
      expect(mod.isRemoteMode()).toBe(true); // genuinely-remote config classifies remote

      const probe = probeFor(); // restart window: local ComfyUI still booting
      const verdict = await judgeHelloRetarget({
        helloUrl: "http://127.0.0.1:8188",
        currentUrl: mod.getComfyUIBaseUrl(),
        probe,
      });
      expect(verdict.apply).toBe(true);
      expect(verdict.reason).toBe("current-also-unreachable");

      expect(mod.setComfyuiTarget(verdict.base!)).toBe(true);
      // Local classification holds after the retarget: train refs resolve
      // locally (isRemoteMode() gates "ref items need a LOCAL ComfyUI")…
      expect(mod.isRemoteMode()).toBe(false);
      expect(mod.isLocalMode()).toBe(true);
      // …and Manager's queue probing (managerBaseUrl() = getComfyUIBaseUrl())
      // targets the reconnected local server, not the dead remote.
      expect(mod.getComfyUIBaseUrl()).toBe("http://127.0.0.1:8188");
    } finally {
      process.env = OLD_ENV;
    }
  });

  it("VETOES a dead hello while the current target is healthy (#303 zombie-tab guard preserved)", async () => {
    const probe = probeFor("http://127.0.0.1:8188"); // current answers, corpse doesn't
    const verdict = await judgeHelloRetarget({
      helloUrl: "http://127.0.0.1:8189",
      currentUrl: "http://127.0.0.1:8188",
      probe,
    });
    expect(verdict.apply).toBe(false);
    expect(verdict.reason).toBe("vetoed-unreachable");
    expect(probe).toHaveBeenCalledWith("http://127.0.0.1:8189/system_stats");
    expect(probe).toHaveBeenCalledWith("http://127.0.0.1:8188/system_stats");
  });

  it("a transiently-unreachable REMOTE hello does not flip a healthy LOCAL target (#303, remote direction)", async () => {
    const probe = probeFor("http://127.0.0.1:8188");
    const verdict = await judgeHelloRetarget({
      helloUrl: "http://comfy.example-vps.com:8188",
      currentUrl: "http://127.0.0.1:8188",
      probe,
    });
    expect(verdict.apply).toBe(false);
    expect(verdict.reason).toBe("vetoed-unreachable");
  });

  it("a transiently-unreachable LOCAL hello does not flip a healthy REMOTE target (genuinely-remote stays remote)", async () => {
    const probe = probeFor("http://192.168.1.50:8188");
    const verdict = await judgeHelloRetarget({
      helloUrl: "http://127.0.0.1:8188",
      currentUrl: "http://192.168.1.50:8188",
      probe,
    });
    expect(verdict.apply).toBe(false);
    expect(verdict.reason).toBe("vetoed-unreachable");
  });

  it("APPLIES a healthy hello without probing the current target", async () => {
    const probe = probeFor("http://192.168.1.50:8188");
    const verdict = await judgeHelloRetarget({
      helloUrl: "http://192.168.1.50:8188",
      currentUrl: "http://127.0.0.1:8188",
      probe,
    });
    expect(verdict.apply).toBe(true);
    expect(verdict.reason).toBe("healthy");
    expect(probe).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledWith("http://192.168.1.50:8188/system_stats");
  });

  it("APPLIES a RunPod proxy hello WITHOUT probing (booting pods answer late — #303)", async () => {
    const probe = probeFor();
    const verdict = await judgeHelloRetarget({
      helloUrl: "https://abc123-8188.proxy.runpod.net",
      currentUrl: "http://127.0.0.1:8188",
      probe,
    });
    expect(verdict.apply).toBe(true);
    expect(verdict.reason).toBe("runpod-proxy");
    expect(probe).not.toHaveBeenCalled();
  });

  it("a same-target hello is a no-op APPLY and is NEVER probed (no restart-window stall)", async () => {
    const probe = probeFor();
    const verdict = await judgeHelloRetarget({
      helloUrl: "http://127.0.0.1:8188/",
      currentUrl: "http://127.0.0.1:8188",
      probe,
    });
    expect(verdict.apply).toBe(true);
    expect(verdict.reason).toBe("same-target");
    expect(probe).not.toHaveBeenCalled();
  });

  it("rejects a non-string hello URL without probing", async () => {
    const probe = probeFor();
    const verdict = await judgeHelloRetarget({ helloUrl: undefined, currentUrl: "http://127.0.0.1:8188", probe });
    expect(verdict.apply).toBe(false);
    expect(verdict.reason).toBe("not-a-url");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("canonComfyuiTargetUrl", () => {
  it("strips the scheme's default port only (http:443 and http:80 are NOT the same endpoint)", () => {
    // Trailing slashes (including the root "/") are stripped by the canon.
    expect(canonComfyuiTargetUrl("http://example.com:80/")).toBe("http://example.com");
    expect(canonComfyuiTargetUrl("https://example.com:443/")).toBe("https://example.com");
    expect(canonComfyuiTargetUrl("http://example.com:443/")).toBe("http://example.com:443");
    expect(canonComfyuiTargetUrl("https://example.com:80/")).toBe("https://example.com:80");
  });

  it("strips trailing slashes and tolerates unparseable input", () => {
    expect(canonComfyuiTargetUrl("http://127.0.0.1:8188///")).toBe("http://127.0.0.1:8188");
    expect(canonComfyuiTargetUrl("not a url//")).toBe("not a url");
  });
});
