/**
 * #1371 — a model was written into a DIFFERENT local ComfyUI installation than the one
 * serving the session.
 *
 * The reporter was connected to ComfyUI on `:8190` (`…\ComfyUI_H3`), and the download
 * streamed into `…\ComfyUI\models` — a stale `COMFYUI_PATH` belonging to another
 * install — while visibility was checked against the connected server.
 *
 * ## Why the existing guard did not catch it
 *
 * `model-resolver.ts` has refused divergent destinations since v0.49.4, and the
 * reporter was on 0.50.107 — newer — so the guard was present and did not fire. It
 * proves divergence from CONTENT: files present on disk that the running server does
 * not list. With a sparse or empty destination category (`vae`, here) there is nothing
 * to compare, so nothing can be proven and the write proceeds.
 *
 * That guard's own note explains why it cannot simply be widened: "the server lists
 * models this tree does not contain" is ABSENCE of evidence, and every time that rule
 * was tightened it produced another false refusal of a legitimate destination.
 *
 * ## The evidence this adds instead
 *
 * `resolveModelSubfolderPreferServer` already roots the destination at the server's own
 * models dir when it can — but it falls back to `<COMFYUI_PATH>/models` when the server
 * was not launched with `--base-directory`, and nothing then checks that the fallback
 * plausibly belongs to THAT server.
 *
 * A server can still identify its install root through its `main.py` argv even without
 * `--base-directory` (`liveRootFromArgv`). When that root resolves AND the destination
 * lies outside it, the two installs are PROVABLY different — that is positive evidence,
 * not the absence of it, so refusing on it does not reintroduce the false-refusal class.
 *
 * Everything here is conditional on that proof existing. No server root, no refusal:
 * an unmeasurable setup must keep working exactly as it does today.
 */

import { resolve, sep } from "node:path";

/** Is `child` the same directory as `parent`, or inside it? Case-insensitive on
 *  Windows, where the same install is routinely spelled with a different drive-letter
 *  case or a mixed-case user directory. */
export function isWithinRoot(child: string, parent: string): boolean {
  if (!child || !parent) return false;
  const norm = (p: string) => {
    const r = resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + sep) || c.startsWith(p + "/");
}

/**
 * The refusal for a destination the connected server provably does not read.
 *
 * Returns `null` — proceed, unchanged — unless BOTH roots are known AND the
 * destination lies outside the server's own install root.
 */
export function divergentInstallRefusal(opts: {
  targetDir: string;
  /** The install root the CONNECTED server reported for itself (argv-derived). */
  serverRoot?: string;
  /** The URL of the connected server, for the message. */
  serverUrl?: string;
  /** True when the destination came from the live server rather than local config —
   *  then there is nothing to disagree with and this must not fire. */
  liveAuthoritative?: boolean;
}): string | null {
  const { targetDir, serverRoot, serverUrl, liveAuthoritative } = opts;
  if (liveAuthoritative) return null;
  if (!targetDir || !serverRoot) return null; // no proof — behave exactly as before
  if (isWithinRoot(targetDir, serverRoot)) return null;
  return (
    `NOT downloaded: the destination "${targetDir}" is outside the install root the ` +
    `connected ComfyUI${serverUrl ? ` (${serverUrl})` : ""} reports for itself ` +
    `("${serverRoot}"), so that server does not read it. This destination came from ` +
    `LOCAL CONFIGURATION — COMFYUI_PATH or the saved default workspace — not from the ` +
    `running server, and a COMFYUI_PATH left over from a different installation is the ` +
    `usual cause (#1371). Nothing was written.\n\n` +
    `This is not a guess about an unverifiable destination: the server named its own ` +
    `root and the destination is not under it. Point COMFYUI_PATH at the ComfyUI that ` +
    `is actually running, or launch that server with an absolute --base-directory so ` +
    `the destination can be taken from it directly, then retry. If you MEANT to place ` +
    `the file in a different install, download it there — writing it here would report ` +
    `success for a model the connected server can never load.`
  );
}
