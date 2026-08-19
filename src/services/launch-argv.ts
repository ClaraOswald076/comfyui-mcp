import { isAbsolute, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Pure launch-argv parsing.
//
// These helpers answer ONE question — "what did the running server's launch
// flags say?" — from an argv array and the server-reported cwd. No fs, no
// network, no config: both output-dir.ts (output/models/download resolution)
// and workspace-env.ts (the live-aware install base, #1715) build on them, and
// keeping them in their own leaf module is what lets workspace-env use them
// WITHOUT importing output-dir — those two already import in the other
// direction, and a cycle here broke vitest's async mock-factory resolution in
// download-dest-roots.test.ts.
// ---------------------------------------------------------------------------

/** Read a flag's value supporting both `--flag value` and `--flag=value`. */
export function flagValue(argv: string[], index: number, flag: string): string | undefined {
  const token = argv[index];
  if (token === flag) return argv[index + 1];
  if (token.startsWith(`${flag}=`)) return token.slice(flag.length + 1);
  return undefined;
}

/**
 * Resolve a value from the server's launch flags the way ComfyUI does — via
 * `os.path.abspath(...)`, i.e. relative to the SERVER PROCESS cwd, NOT the MCP
 * process cwd / COMFYUI_PATH. An ABSOLUTE value is used as-is. A RELATIVE value
 * needs the server's reported cwd; WITHOUT it we return undefined (UNRESOLVABLE)
 * rather than guess a wrong MCP-relative path (which would land the download where
 * the server never reads — the very #346 bug). Requires an ABSOLUTE serverCwd.
 */
export function resolveServerLaunchPath(value: string, serverCwd?: string): string | undefined {
  if (isAbsolute(value)) return resolve(value);
  if (serverCwd && isAbsolute(serverCwd)) return resolve(serverCwd, value);
  return undefined; // relative value + no authoritative server cwd → unresolvable
}

/** Raw last value of a repeated single-value launch flag (no resolution). */
export function rawFlagValue(argv: string[] | undefined, flag: string): string | undefined {
  if (!argv || argv.length === 0) return undefined;
  let v: string | undefined;
  for (let i = 0; i < argv.length; i++) v = flagValue(argv, i, flag) ?? v;
  return v;
}

/**
 * True when the server's launch argv carries a `--base-directory` that is PRESENT
 * but UNRESOLVABLE — a relative value with no absolute server-reported cwd.
 *
 * This is the one shape in which every root we could otherwise derive is a
 * WRONG answer rather than merely an unproven one. ComfyUI derives custom_nodes
 * from `<server cwd>/<flag>`, and with no cwd that path cannot be computed — yet
 * the install root (from argv) and the OS-observed process root are both still
 * derivable, and both name a DIFFERENT tree than the one being served. A caller
 * that gates a destructive directory swap must fail closed here, not adopt a
 * confidently-derived root that the flag has already overridden.
 *
 * Narrower than `hasUnresolvableRelativeModelDirFlag` on purpose: that one also
 * fires on `--models-directory`, which relocates MODELS and says nothing about
 * where custom_nodes lives, so folding it in here would refuse panel operations
 * for a flag that cannot affect them (the very over-refusal #1133 is about).
 */
export function hasUnresolvableRelativeBaseDirFlag(
  argv: string[] | undefined,
  serverCwd?: string,
): boolean {
  if (serverCwd && isAbsolute(serverCwd)) return false; // all relatives resolvable
  const base = rawFlagValue(argv, "--base-directory");
  return base !== undefined && !isAbsolute(base);
}

/**
 * Parse the running server's base directory (`--base-directory`) out of its
 * launch argv, resolved against the SERVER cwd (ComfyUI uses os.path.abspath).
 * This is the authoritative root ComfyUI derives models/, input/, output/, and
 * user/ from — on a Desktop install it commonly points at a drive entirely
 * different from COMFYUI_PATH. Returns undefined when the flag is absent OR when a
 * relative value can't be resolved without the server cwd (UNRESOLVABLE).
 */
export function parseBaseDirFromArgv(
  argv: string[] | undefined,
  serverCwd?: string,
): string | undefined {
  const baseDir = rawFlagValue(argv, "--base-directory");
  return baseDir !== undefined ? resolveServerLaunchPath(baseDir, serverCwd) : undefined;
}
