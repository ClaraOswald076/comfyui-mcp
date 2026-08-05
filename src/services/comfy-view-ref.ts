// Decide whether an absolute path on the ORCHESTRATOR host names a file the
// connected ComfyUI can serve over /view — and, when it can, produce the exact
// ref to hand the panel.
//
// WHY THIS EXISTS (#648). panel_show_media's absolute-path branch base64-encodes
// the whole file into the tool reply, so it must cap the payload. The cap is
// correct — a 72 MB inline payload is not something to send an agent, and
// raising it is not the fix. But on its own the cap is a DEAD END: an agent
// asked to preview an ordinary local reference video was told only that a
// ceiling exists, with nothing it could do about it, so it concluded the task
// was impossible.
//
// A file that ALREADY lives under a directory ComfyUI serves needs no inline
// payload at all. The panel is a browser tab on ComfyUI's own origin, so it
// fetches /view directly; there is no size cap on that path, and a viewRef
// video arriving at the panel gets the full sampled-frame preview and
// disclosure. So the remedy is to forward a ref instead of refusing.
//
// THREE ANSWERS, NOT TWO. The naive check ("is the path under the output dir?")
// collapses "we could not find out" into "no", which sends the caller to move a
// file that may already be in exactly the right place. This module keeps them
// apart:
//
//   servable — PROVEN inside a directory this ComfyUI serves. Emits the ref.
//   outside  — the roots WERE resolved and the file is provably in none of them.
//   unknown  — the roots could not be resolved. NOT "outside".
//   remote   — ComfyUI runs on another host, so a path on THIS machine names a
//              file that server cannot open, whatever the path says.
//
// EVIDENCE, NOT ASSUMPTION. The roots come from resolveOutputDir/resolveInputDir,
// which ask the RUNNING server for its launch argv (--output-directory /
// --base-directory) before falling back to <COMFYUI_PATH>/output. That matters:
// ComfyUI is routinely launched with its output elsewhere, and assuming
// <COMFYUI_PATH>/output would mint refs that resolve to nothing.
//
// Deliberately NOT resolveEffectiveComfyUIBase(): it returns config.comfyuiPath
// BEFORE it checks remote mode, contradicting its own docstring (#490, owned
// elsewhere — not fixed here, and not built on either). The same exposure reaches
// this module by another route, because localOutputDirFallback() also reads
// config.comfyuiPath directly, and an explicitly-set COMFYUI_PATH survives into
// remote mode. That is exactly why the remote check runs FIRST, before any root
// is resolved: otherwise a remote session with COMFYUI_PATH set would compare a
// local file against a local-looking root and call it servable, and the panel
// would resolve that ref against the REMOTE server — showing a different file,
// or nothing. Never let a coincidence of path strings stand in for evidence that
// the server can reach the file.
//
// NOT COVERED: ComfyUI's temp directory. There is no --temp-directory parser in
// this codebase, so a file under it cannot be recognised. The refusal therefore
// names the directories it actually checked rather than claiming no directory
// could serve the file.

import { realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { isCloudMode, isRemoteMode } from "../config.js";
import { resolveInputDir, resolveOutputDir } from "./output-dir.js";

/** The /view directories this module can establish from evidence. */
export type ViewRefKind = "output" | "input";

/** A ref in exactly the shape panel_show_media forwards and /view accepts. */
export type ComfyServableRef = {
  filename: string;
  subfolder?: string;
  type: ViewRefKind;
};

export type CheckedRoot = { kind: ViewRefKind; dir: string };

export type ViewRefResolution =
  | { status: "servable"; ref: ComfyServableRef; root: CheckedRoot }
  | { status: "outside"; checked: CheckedRoot[] }
  | { status: "remote"; reason: string }
  | { status: "unknown"; reason: string };

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/** Windows compares paths case-insensitively; POSIX does not. */
const norm = (p: string): string =>
  process.platform === "win32" ? p.toLowerCase() : p;

/**
 * The real path, or the lexical one when it cannot be resolved.
 *
 * Resolving a symlink is itself an operation that can fail (a broken link, a
 * permission wall, a dead network share). Falling back to the lexical path keeps
 * this a guard rather than a new failure mode — and the containment test below
 * is still applied to whatever comes back, so a fallback can only ever make the
 * check stricter, never let something through.
 */
async function realOrLexical(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

/**
 * STRICT containment: `child` sits somewhere beneath `root`.
 *
 * Equality is deliberately excluded — the caller has already established the
 * path is a regular file, so a path equal to the root is a contradiction, and
 * admitting it would derive an empty filename.
 *
 * The separator is required, so `/comfy/output-old/x.mp4` is not treated as
 * living under `/comfy/output`.
 */
function isStrictlyInside(child: string, root: string): boolean {
  const r = norm(root);
  const withSep = r.endsWith(sep) ? r : r + sep;
  return norm(child).startsWith(withSep);
}

/**
 * Why a derived ref is not safe to forward, or null when it is.
 *
 * Containment should already guarantee this shape, but the ref is about to be
 * handed to ComfyUI's /view, which has historically been permissive about ".."
 * and absolute values in these parameters. A derived value that fails here means
 * the derivation did something this module did not predict — so the answer is
 * "unknown", never a silently-emitted bad ref.
 */
function refShapeProblem(filename: string, subfolder: string): string | null {
  if (!filename) return "the derived filename is empty";
  if (filename.includes("\0") || subfolder.includes("\0")) {
    return "the derived ref contains a NUL byte";
  }
  if (filename.includes("/") || filename.includes("\\")) {
    return "the derived filename is not a single path segment";
  }
  if (filename === "." || filename === "..") {
    return "the derived filename is a directory entry, not a file";
  }
  if (subfolder.startsWith("/") || /^[A-Za-z]:/.test(subfolder)) {
    return "the derived subfolder is not relative to the media directory";
  }
  if (subfolder.split("/").some((s) => s === "..")) {
    return "the derived subfolder escapes the media directory";
  }
  return null;
}

/**
 * Establish whether `absPath` is servable by the connected ComfyUI over /view.
 *
 * Never throws: every step (a network probe for the launch argv, a realpath, the
 * path arithmetic) is an operation that can fail, and a guard that throws is not
 * a guard — a failure here has to come back as `unknown`, which the caller can
 * report honestly, not as an exception that reaches the agent as a transport
 * error with no remedy in it.
 */
export async function resolveServableViewRef(
  absPath: string,
): Promise<ViewRefResolution> {
  // FIRST, before any root is resolved — see the module header. A local path
  // cannot be servable by a server on another machine, and a root that merely
  // looks local is not evidence that it is.
  if (isCloudMode()) {
    return {
      status: "remote",
      reason:
        "this session targets ComfyUI Cloud, which has no access to this machine's filesystem",
    };
  }
  if (isRemoteMode()) {
    return {
      status: "remote",
      reason:
        "this session targets a REMOTE ComfyUI on a different host, which has no access to this machine's filesystem",
    };
  }

  const roots: CheckedRoot[] = [];
  const failures: string[] = [];
  // Resolved INDEPENDENTLY: one directory failing must not discard the other.
  // A file proven to be under a resolved output dir is servable whether or not
  // the input dir could be resolved.
  for (const kind of ["output", "input"] as const) {
    try {
      const dir = await (kind === "output"
        ? resolveOutputDir()
        : resolveInputDir());
      if (typeof dir === "string" && dir.length > 0) {
        roots.push({ kind, dir: resolve(dir) });
      } else {
        failures.push(`the ${kind} directory resolved to an empty value`);
      }
    } catch (err) {
      failures.push(`the ${kind} directory could not be resolved (${errText(err)})`);
    }
  }

  if (roots.length === 0) {
    return {
      status: "unknown",
      reason:
        failures.join("; ") ||
        "no ComfyUI media directory could be resolved",
    };
  }

  try {
    const real = await realOrLexical(resolve(absPath));
    for (const root of roots) {
      const realRoot = await realOrLexical(root.dir);
      if (!isStrictlyInside(real, realRoot)) continue;
      // Derived from the REAL paths on both sides, so a symlinked entry inside
      // the root cannot name a file outside it. realRoot and root.dir are the
      // same directory, so the relative path is valid against either — which is
      // what ComfyUI joins onto its own configured root.
      const rel = relative(realRoot, real);
      const filename = basename(rel);
      const parent = dirname(rel);
      const subfolder =
        parent === "." || parent === "" ? "" : parent.split(sep).join("/");
      const problem = refShapeProblem(filename, subfolder);
      if (problem) {
        return {
          status: "unknown",
          reason: `the file is under ComfyUI's ${root.kind} directory but ${problem}`,
        };
      }
      return {
        status: "servable",
        ref: { filename, ...(subfolder ? { subfolder } : {}), type: root.kind },
        root,
      };
    }
  } catch (err) {
    return {
      status: "unknown",
      reason: `the path could not be compared against ComfyUI's media directories (${errText(err)})`,
    };
  }

  // Matched nothing. Whether that means "outside" depends on whether every
  // directory was actually checked: with one unresolved, the file could be
  // sitting in it, and reporting "outside" would send the caller to move a file
  // that is already in the right place.
  if (failures.length > 0) {
    return {
      status: "unknown",
      reason:
        `it is not under ${roots.map((r) => `ComfyUI's ${r.kind} directory (${r.dir})`).join(" or ")}, ` +
        `but ${failures.join("; ")} — so whether ComfyUI can serve it is undetermined`,
    };
  }
  return { status: "outside", checked: roots };
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * The refusal for a file too large to inline that could NOT be forwarded by
 * reference — stating the limit, why it exists, and a remedy that works from
 * where the caller actually is.
 *
 * Every branch ends in something the caller can do NEXT, from its current state.
 * A bare ceiling is not a remedy: it names a fact and leaves the caller with no
 * move, which is the whole defect this addresses.
 */
export function oversizedInlineRefusal(opts: {
  path: string;
  sizeBytes: number;
  capBytes: number;
  kind: "image" | "video";
  resolution: ViewRefResolution;
}): string {
  const { path, sizeBytes, capBytes, kind, resolution } = opts;

  const seeItYourself =
    kind === "video"
      ? "The panel then builds a SAMPLED contact sheet of the video for you; you are still not sent the video itself."
      : "The panel then displays it to the USER at full size. To look at it YOURSELF, call get_image with its filename/subfolder/type — that returns the image inline.";

  const head =
    `file too large to send inline (${mb(sizeBytes)} > ${mb(capBytes)} cap): ${path}\n` +
    `The cap applies to the INLINE path only: this tool base64-encodes the file into the reply, and a payload that size would swamp the context. ` +
    `There is a route with no size limit — a file that lives under a directory ComfyUI serves is displayed BY REFERENCE, because the panel is a browser tab on ComfyUI's own origin and fetches it directly.`;

  if (resolution.status === "remote") {
    return (
      `${head}\n` +
      `That route is unavailable here: ${resolution.reason}. A path on this machine names a file that server cannot open, so no reference to it would resolve.\n` +
      `What you can do:\n` +
      `  1. Put the file on the ComfyUI host — upload it into that server's input directory — then call panel_show_media with a ComfyUI reference ({ filename, type: "input" }) instead of a path.\n` +
      `  2. Ask the user to open the file themselves; it is on the machine they are at.`
    );
  }

  if (resolution.status === "unknown") {
    return (
      `${head}\n` +
      `Whether that route is available could NOT be determined: ${resolution.reason}. ` +
      `That is not the same as knowing the file is in the wrong place — it may already be under a directory ComfyUI serves.\n` +
      `What you can do:\n` +
      `  1. Make the directories resolvable and retry: check ComfyUI is running and reachable (its launch arguments are the primary source), or set COMFYUI_PATH to the ComfyUI install.\n` +
      `  2. Copy the file under ComfyUI's output directory and call panel_show_media again with the new path.\n` +
      `  3. Ask the user to open the file themselves.`
    );
  }

  if (resolution.status === "outside") {
    const list = resolution.checked
      .map((r) => `    - ${r.kind}: ${r.dir}`)
      .join("\n");
    return (
      `${head}\n` +
      `This file is not under any directory this ComfyUI serves. Checked:\n${list}\n` +
      `What you can do:\n` +
      `  1. Copy or move it under one of the directories above (a subfolder is fine) and call panel_show_media again with the NEW path. ${seeItYourself}\n` +
      `  2. Ask the user to move it, or to open it themselves; it is on the machine they are at.`
    );
  }

  // A servable file is not refused — reaching here means the caller ignored the
  // resolution. Say so rather than inventing a reason it could not be shown.
  return (
    `file too large to send inline (${mb(sizeBytes)} > ${mb(capBytes)} cap): ${path}\n` +
    `This file IS servable by reference and should not have been refused; this is a bug in panel_show_media, not a problem with the file.`
  );
}

/** One item that was forwarded by reference instead of inlined. */
export type ForwardedByReference = {
  path: string;
  sizeBytes: number;
  kind: "image" | "video";
  ref: ComfyServableRef;
};

/**
 * What the agent is told about items that took the reference route.
 *
 * States ONLY what this process did — it forwarded a reference. Whether the
 * panel actually displayed anything is in the panel's own reply, which reports
 * its paint outcomes; claiming a display here would be fabricating a result this
 * code never observed.
 */
export function forwardedByReferenceNote(
  items: ForwardedByReference[],
  capBytes: number,
): string {
  const lines = items.map((it) => {
    const where = it.ref.subfolder
      ? `type "${it.ref.type}", subfolder "${it.ref.subfolder}"`
      : `type "${it.ref.type}"`;
    return `  - ${it.ref.filename} (${mb(it.sizeBytes)}, ${it.kind}) — ${where}`;
  });
  const anyVideo = items.some((it) => it.kind === "video");
  const anyImage = items.some((it) => it.kind === "image");
  const howToSee = [
    anyImage
      ? `To look at an IMAGE yourself, call get_image with the filename/type/subfolder above — it comes back inline.`
      : null,
    anyVideo
      ? `A VIDEO is never sent to you inline; the panel's reply above carries a sampled contact sheet and says what it does and does not show. get_image on a video saves it to disk and returns the path.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    `NOTE — ${items.length === 1 ? "1 item was" : `${items.length} items were`} over the ${mb(capBytes)} inline cap, ` +
    `so ${items.length === 1 ? "it was" : "they were"} sent to the panel as ComfyUI /view reference${items.length === 1 ? "" : "s"} instead of inline data ` +
    `(that path has no size limit):\n${lines.join("\n")}\n` +
    `You were NOT sent the bytes of ${items.length === 1 ? "this file" : "these files"}. Whether the panel displayed ${items.length === 1 ? "it" : "them"} is in its reply above, not here. ` +
    howToSee
  );
}
