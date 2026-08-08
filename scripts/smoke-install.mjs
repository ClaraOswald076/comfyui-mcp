#!/usr/bin/env node
/**
 * Release smoke test: pack the package exactly as `npm publish` would, install
 * that tarball into a clean throwaway project (which RUNS the postinstall hook),
 * and verify the published layout + entrypoint actually boot.
 *
 * Catches the class of bug that shipped in 0.17.0: a `files` allowlist that
 * dropped `scripts/` while `package.json` still declared
 * `postinstall: node scripts/postinstall.mjs` — so every `npm install` / `npx`
 * crashed on a missing file. Unit tests (`npm test`) never exercise the packed
 * tarball, so this is the gap. Run in CI and as a pre-publish gate.
 */
import { execSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Ask the installed server for its tool list over MCP stdio. Resolves to the
 * names, or null if it never answers within the budget — a silence this script
 * reports rather than reading as "no tools".
 */
function listTools(entry) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [entry], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, COMFYUI_URL: "http://127.0.0.1:59999" },
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    let buf = "";
    const done = (v) => { try { child.kill(); } catch { /* already gone */ } resolve(v); };
    const timer = setTimeout(() => done(null), 60_000);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 1) send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        if (msg.id === 2) {
          clearTimeout(timer);
          done((msg.result?.tools ?? []).map((t) => t.name));
        }
      }
    });
    child.on("error", () => { clearTimeout(timer); done(null); });
    send({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "smoke", version: "1" } },
    });
  });
}

const run = (cmd, opts = {}) => {
  console.log(`$ ${cmd}${opts.cwd ? `  (cwd: ${opts.cwd})` : ""}`);
  execSync(cmd, { stdio: "inherit", ...opts });
};

// 1. Pack exactly what `npm publish` would upload.
const packDir = mkdtempSync(join(tmpdir(), "cmcp-pack-"));
run(`npm pack --pack-destination "${packDir}"`);
const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
if (!tgz) throw new Error("npm pack produced no tarball");
const tarball = join(packDir, tgz);

// 2. Install the tarball in a clean project — this RUNS the postinstall hook.
const proj = mkdtempSync(join(tmpdir(), "cmcp-smoke-"));
writeFileSync(
  join(proj, "package.json"),
  JSON.stringify({ name: "comfyui-mcp-smoke", private: true, version: "0.0.0" }),
);
// --foreground-scripts surfaces postinstall output; a crashing hook exits non-zero.
run(`npm install --foreground-scripts --no-audit --no-fund "${tarball}"`, { cwd: proj });

// 3. Verify the published layout is intact (files the runtime/install need).
const pkg = join(proj, "node_modules", "comfyui-mcp");
for (const f of ["dist/index.js", "scripts/postinstall.mjs", "package.json"]) {
  if (!existsSync(join(pkg, f))) {
    console.error(`❌ published package is missing ${f}`);
    process.exit(1);
  }
}
if (!existsSync(join(proj, "node_modules", ".bin", "comfyui-mcp")) &&
    !existsSync(join(proj, "node_modules", ".bin", "comfyui-mcp.cmd"))) {
  console.error("❌ comfyui-mcp bin was not linked");
  process.exit(1);
}

// 4. Entrypoint parses (syntax) and boots without an immediate crash.
run(`node --check "${join(pkg, "dist/index.js")}"`);
const boot = spawnSync(process.execPath, [join(pkg, "dist/index.js")], {
  input: "",
  timeout: 8000,
  encoding: "utf8",
});
// Pass if it stayed up until the timeout (SIGTERM) or exited cleanly on stdin EOF.
if (boot.signal === "SIGTERM" || boot.status === 0) {
  console.log(`✅ entrypoint boots (signal=${boot.signal}, status=${boot.status})`);
} else {
  console.error(`❌ entrypoint crashed on boot (status=${boot.status}, signal=${boot.signal})`);
  if (boot.stdout) console.error("stdout:\n" + boot.stdout);
  if (boot.stderr) console.error("stderr:\n" + boot.stderr);
  process.exit(1);
}

// 5. The published surface actually REGISTERS. Booting proves the process starts;
//    it does not prove the tools are there. A packaging or registration
//    regression that leaves the server up but short a tool would pass step 4 and
//    ship — the user finds out when the tool they wanted is simply absent.
//
//    Driven over real MCP stdio against the INSTALLED tarball, so this is the
//    surface a user gets, not the one the repo builds. COMFYUI_URL points at a
//    dead port on purpose: registration must not depend on a reachable ComfyUI.
// The ledger IS the list, not a ceiling: TOOL_NAMES holds every core tool, and
// MAX_TOOLS beside it is a budget target that merely happens to match today.
// Counting the list keeps this honest if the two ever diverge.
const LEDGER = readFileSync(join(process.cwd(), "src/tools/vocabulary.ts"), "utf-8");
const EXPECTED_CORE = (
  LEDGER.match(/TOOL_NAMES\s*=\s*\[[\s\S]*?\n\]/)?.[0].match(/"[a-z][a-z0-9_]*"/g) ?? []
).length;
const surface = await listTools(join(pkg, "dist/index.js"));
if (surface === null) {
  console.error("❌ the installed server never answered tools/list");
  process.exit(1);
}
// The three compact-mode meta tools (list_tools / describe_tool / call_tool) are
// registered ALONGSIDE the core surface and are deliberately absent from the
// ledger, so they are counted out rather than expected in it.
const META = ["list_tools", "describe_tool", "call_tool"];
const core = surface.filter((n) => !META.includes(n));
const missingMeta = META.filter((n) => !surface.includes(n));
if (EXPECTED_CORE > 0 && core.length !== EXPECTED_CORE) {
  console.error(
    `❌ installed surface has ${core.length} core tools, ledger declares ${EXPECTED_CORE}` +
      `\n   registered: ${core.join(", ")}`,
  );
  process.exit(1);
}
if (missingMeta.length) {
  console.error(`❌ compact-mode tools missing from the installed surface: ${missingMeta.join(", ")}`);
  process.exit(1);
}
console.log(`✅ installed surface registers ${core.length} core tools + ${META.length} compact-mode tools`);

console.log("✅ pack/install smoke passed — tarball installs cleanly, boots, and registers its tools");
