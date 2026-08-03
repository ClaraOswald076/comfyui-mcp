// Where does THE PANEL live? (#766, #769)
//
// Every other filesystem-backed tool asks `resolveEffectiveComfyUIBase()` — a
// SYNCHRONOUS reader of COMFYUI_PATH / the saved default workspace. That is the
// right answer for "where do models go", but it is the WRONG question for the
// sidebar panel, because the panel is not a file the user reads: it is a web
// extension that the RUNNING ComfyUI serves to the browser tab. The only
// custom_nodes that can possibly matter is the one belonging to the server this
// orchestrator is actually talking to.
//
// Two real deployments broke because those two answers differ:
//
//  - #766 (Comfy Desktop dual-path). Desktop launches ComfyUI out of its own
//    program directory but passes `--base-directory <Documents\ComfyUI>`, and
//    ComfyUI derives custom_nodes/ from THAT. The configured workspace pointed
//    at the program directory, so install_panel reported `installed: false`
//    while a perfectly good 0.11.x panel sat in the Documents tree — and any
//    install would have landed in a custom_nodes the server never reads.
//
//  - #769 (no configured workspace at all). `get_environment` already resolves
//    the live root from the serving process and reports it as the local
//    workspace, but install_panel asked the sync resolver, got nothing, and
//    refused with "no local ComfyUI (COMFYUI_PATH) is configured" about an
//    install it had just been told the path to.
//
// So: resolve LIVE-FIRST, exactly like `resolveInstallInterpreter` does for the
// interpreter — the running server's own launch argv is the ground truth, and a
// configured path is the fallback, not the other way round. Two guard rails keep
// that honest:
//
//  1. A live-derived base is only ACCEPTED when it actually contains a
//     `custom_nodes` directory. Otherwise we would confidently point the panel
//     tooling at a tree that has none and report a false "not installed".
//  2. Nothing here is a guess. If the server is unreachable, or its argv yields
//     no resolvable root, we fall straight back to the configured base and SAY
//     which one we used (`source`), so a wrong answer is diagnosable instead of
//     silent.
//
// Remote/cloud mode resolves to nothing at all: the live root is a path on
// SOMEONE ELSE'S filesystem and must never be handed to a local `join()`.

import { statSync } from "node:fs";
import { join } from "node:path";
import { getComfyUIBaseUrl, isLocalMode } from "../config.js";
import { parseBaseDirFromArgv } from "./output-dir.js";
import {
  getLiveServerSnapshot,
  liveRootFromArgv,
  resolveEffectiveComfyUIBase,
} from "./workspace-env.js";

/** How the panel's ComfyUI base was resolved — reported so it is diagnosable. */
export type PanelBaseSource =
  /** The running server's `--base-directory` (Comfy Desktop dual-path, #766). */
  | "live-base-directory"
  /** The running server's own install root, from its launch argv (#769). */
  | "live-argv-root"
  /** COMFYUI_PATH or the saved default workspace. */
  | "configured"
  /** Remote/cloud, or nothing resolvable. */
  | "none";

export interface PanelBaseResolution {
  /** The custom_nodes PARENT. undefined ⇒ panel management is not applicable. */
  base?: string;
  source: PanelBaseSource;
  /**
   * What the ordinary sync resolver would have said. Present whenever it
   * DISAGREES with `base` — the #766 signal, worth surfacing to the user.
   */
  overriddenConfiguredBase?: string;
}

/** Does this candidate root actually hold a custom_nodes directory? */
function hasCustomNodes(base: string): boolean {
  try {
    return statSync(join(base, "custom_nodes")).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the ComfyUI root whose `custom_nodes` serves the panel, preferring the
 * LIVE server over any configured path. Never throws; returns `source: "none"`
 * when nothing local is resolvable.
 */
export async function resolvePanelBase(): Promise<PanelBaseResolution> {
  // Remote/cloud: the serving filesystem is not ours. Do not fall back to a
  // configured local path — that dir is not the panel the browser loads.
  if (!isLocalMode()) return { source: "none" };

  const configured = resolveEffectiveComfyUIBase();
  const snapshot = await getLiveServerSnapshot();
  if (snapshot.reachable) {
    // `--base-directory` FIRST: when ComfyUI is launched with it, that flag —
    // not the main.py location — is the root it derives custom_nodes/ from.
    const candidates: Array<[string | undefined, PanelBaseSource]> = [
      [parseBaseDirFromArgv(snapshot.argv, snapshot.cwd), "live-base-directory"],
      [liveRootFromArgv(snapshot.argv, snapshot.cwd), "live-argv-root"],
    ];
    for (const [candidate, source] of candidates) {
      // Only accept a live base we can PROVE holds custom_nodes. An argv root
      // without one is not the tree the panel lives in, and pointing the
      // installer at it would manufacture a false "not installed".
      if (!candidate || !hasCustomNodes(candidate)) continue;
      return {
        base: candidate,
        source,
        overriddenConfiguredBase:
          configured && configured !== candidate ? configured : undefined,
      };
    }
  }

  if (configured) return { base: configured, source: "configured" };
  return { source: "none" };
}

/*
 * The resolution is async (it reads /system_stats), but `PanelInstallerDeps
 * .comfyuiPath` is synchronous and is consulted from several places inside one
 * operation (detection, the shadow scan, the post-op re-read). Those MUST all
 * see the same answer — a base that changed halfway through would make the
 * "did the pack move?" proof compare two different directories.
 *
 * So the async resolution is primed ONCE at the top of each panel operation and
 * cached; the sync accessor serves that cache. The cache is keyed on the ComFYUI
 * TARGET URL, so retargeting the orchestrator at a different server can never
 * serve the previous one's base — and it expires on a short TTL so a restarted
 * server with new launch flags is picked up without a retarget.
 */
const PANEL_BASE_TTL_MS = 15_000;

let cached:
  | { at: number; target: string; resolution: PanelBaseResolution }
  | undefined;

/** Cache key: which ComfyUI this resolution describes. Never throws. */
function targetKey(): string {
  try {
    return getComfyUIBaseUrl();
  } catch {
    return "";
  }
}

function cachedResolution(): PanelBaseResolution | undefined {
  if (!cached) return undefined;
  if (cached.target !== targetKey()) return undefined;
  if (Date.now() - cached.at > PANEL_BASE_TTL_MS) return undefined;
  return cached.resolution;
}

/**
 * Resolve and cache the panel's ComfyUI base. Call at the START of any panel
 * operation, before the first `deps.comfyuiPath()`, so every read within that
 * operation agrees. Never throws.
 */
export async function primePanelBase(): Promise<PanelBaseResolution> {
  const fresh = cachedResolution();
  if (fresh) return fresh;
  let resolution: PanelBaseResolution;
  try {
    resolution = await resolvePanelBase();
  } catch {
    // A failed probe must not break panel management — fall back to the
    // ordinary sync answer rather than reporting "no local ComfyUI".
    const configured = isLocalMode() ? resolveEffectiveComfyUIBase() : undefined;
    resolution = configured
      ? { base: configured, source: "configured" }
      : { source: "none" };
  }
  cached = { at: Date.now(), target: targetKey(), resolution };
  return resolution;
}

/**
 * The primed base, or — when nothing has been primed in this window — the
 * ordinary sync answer. Deliberately falls back rather than returning
 * undefined: an unprimed caller must keep the pre-#766 behaviour, never lose
 * a workspace it used to see.
 */
export function panelBaseSync(): string | undefined {
  const fresh = cachedResolution();
  if (fresh) return fresh.base;
  if (!isLocalMode()) return undefined;
  return resolveEffectiveComfyUIBase();
}

/** The resolution behind `panelBaseSync()`, for reporting. undefined ⇒ unprimed. */
export function lastPanelBaseResolution(): PanelBaseResolution | undefined {
  return cachedResolution();
}

/** Test hook — drop the cache so the next prime re-resolves. */
export function __resetPanelBaseCache(): void {
  cached = undefined;
}
