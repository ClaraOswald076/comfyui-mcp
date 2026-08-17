import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  installPanelLauncher,
  panelLauncherPaths,
  readPanelLauncherConfig,
  startPanelLauncherBroker,
  terminalCommandForPlatform,
  uninstallPanelLauncher,
} from "../../services/panel-launcher.js";

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    uninstallPanelLauncher({ home, platform: "linux", exec: (() => undefined) as never });
  }
});

function fixture(): { home: string; source: string } {
  const home = mkdtempSync(join(tmpdir(), "cmcp-launcher-"));
  homes.push(home);
  const source = join(home, "source.mjs");
  writeFileSync(source, "// compiled standalone broker\n", "utf8");
  return { home, source };
}

describe("panel launcher install", () => {
  it("installs a stable broker, private token config, and per-user Windows task", () => {
    const { home, source } = fixture();
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const paths = installPanelLauncher({
      home,
      platform: "win32",
      nodePath: "C:\\Node\\node.exe",
      brokerSource: source,
      exec: ((file: string, args: readonly string[]) => {
        calls.push({ file, args });
      }) as never,
    });
    const config = readPanelLauncherConfig(home);
    expect(config).toMatchObject({ protocol: 1, host: "127.0.0.1", port: 0 });
    expect(config?.token.length).toBeGreaterThanOrEqual(32);
    expect(readFileSync(paths.broker, "utf8")).toContain("standalone broker");
    expect(readFileSync(paths.windowsScript, "utf8")).toContain(
      '"C:\\Node\\node.exe"',
    );
    expect(calls.map((call) => call.args[0])).toEqual(["/Create", "/Run"]);
  });

  it("preserves the authentication token across reinstalls", () => {
    const { home, source } = fixture();
    const exec = (() => undefined) as never;
    installPanelLauncher({ home, platform: "win32", brokerSource: source, exec });
    const first = readPanelLauncherConfig(home)?.token;
    installPanelLauncher({ home, platform: "win32", brokerSource: source, exec });
    expect(readPanelLauncherConfig(home)?.token).toBe(first);
  });

  it("writes a Linux user service and falls back to XDG autostart", () => {
    const { home, source } = fixture();
    const paths = installPanelLauncher({
      home,
      platform: "linux",
      nodePath: process.execPath,
      brokerSource: source,
      exec: (() => {
        throw new Error("no systemd user session");
      }) as never,
    });
    expect(readFileSync(paths.linuxService, "utf8")).toContain("ExecStart=");
    expect(readFileSync(paths.linuxAutostart, "utf8")).toContain("X-GNOME-Autostart-enabled=true");
  });
});

describe("panel launcher broker", () => {
  it("binds loopback and rejects requests without the private bearer token", async () => {
    const { home, source } = fixture();
    installPanelLauncher({
      home,
      platform: "win32",
      brokerSource: source,
      exec: (() => undefined) as never,
    });
    const server = await startPanelLauncherBroker(home);
    try {
      const config = readPanelLauncherConfig(home)!;
      const base = `http://127.0.0.1:${config.port}`;
      const denied = await fetch(`${base}/v1/status`);
      expect(denied.status).toBe(401);
      const accepted = await fetch(`${base}/v1/status`, {
        headers: { Authorization: `Bearer ${config.token}` },
      });
      expect(accepted.status).toBe(200);
      const body = await accepted.json() as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, protocol: 1 });
      expect(body).not.toHaveProperty("token");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("native terminal command", () => {
  it("is fixed and always resolves the latest MCP package", () => {
    expect(terminalCommandForPlatform("win32", { ComSpec: "cmd.exe" })).toEqual({
      executable: "cmd.exe",
      args: ["/d", "/k", "npx.cmd -y comfyui-mcp@latest connect"],
    });
    expect(terminalCommandForPlatform("darwin").args.join(" ")).toContain(
      "npx -y comfyui-mcp@latest connect",
    );
    expect(
      terminalCommandForPlatform("linux", { PATH: "/bin" }, (path) => path.endsWith("kgx")),
    ).toEqual({
      executable: "kgx",
      args: ["--", "sh", "-lc", "exec npx -y comfyui-mcp@latest connect"],
    });
  });

  it("fails clearly when Linux has no supported graphical terminal", () => {
    expect(() => terminalCommandForPlatform("linux", { PATH: "/empty" }, () => false)).toThrow(
      "No supported graphical terminal",
    );
  });
});

describe("launcher paths", () => {
  it("keeps every mutable launcher artifact under the selected user home", () => {
    const { home } = fixture();
    const paths = panelLauncherPaths(home);
    expect(paths.config.startsWith(home)).toBe(true);
    expect(paths.broker.startsWith(home)).toBe(true);
  });
});
