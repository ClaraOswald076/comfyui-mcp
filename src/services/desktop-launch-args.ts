import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/**
 * What ComfyUI Desktop SAVED as an install's launch arguments (#848).
 *
 * #848 is a configuration change that appeared to succeed and silently did not take: a
 * flag was added to Desktop's saved launch settings, `panel_restart_comfyui` reported the
 * server healthy, and the flag was absent. #850 already made the restart report whether
 * the running arguments changed — but that sentence has to be conditioned on the user's
 * own expectation ("if you were expecting different arguments…"), because nothing ever
 * opened the settings. It is a hint where an observation was available.
 *
 * This reads the saved arguments so the restart can say the specific thing: the settings
 * ask for X, the running server does not have X. That is two readings compared, in the
 * style of the rest of this cluster — never a claim about WHY they differ, and never a
 * claim that the restart caused it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not apply the arguments. A Desktop backend is
 * Electron-supervised and is never killed here (#400: killing it does not reliably bring
 * the listener back), and a Manager reboot re-execs the running process — so nothing in
 * this process can inject new launch arguments. Only the Desktop app can, at its own
 * launch. Pretending otherwise would be this issue's own defect pointed the other way.
 */
export interface SavedLaunchArgs {
  /** The install's display name in Desktop, for a message the user can act on. */
  name: string;
  /** Tokens exactly as saved. Desktop stores ONE space-separated string, not an array. */
  args: string[];
}

/** The Desktop config directories, in the same order `config.ts` reads them. */
function desktopConfigDirs(): string[] {
  const home = homedir();
  return [
    join(home, "AppData", "Roaming", "Comfy Desktop"), // Windows
    join(home, "Library", "Application Support", "Comfy Desktop"), // macOS
    join(home, ".config", "Comfy Desktop"), // Linux
  ];
}

/** Case- and separator-insensitive path identity, since Desktop and our config can
 *  disagree on trailing slashes and (on Windows) case. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) =>
    resolve(p.trim()).replace(new RegExp(`\\${sep}+$`), "").toLowerCase();
  try {
    return norm(a) === norm(b);
  } catch {
    return false;
  }
}

/**
 * Does this Desktop record describe the install we are running?
 *
 * Desktop's `installPath` is the install ROOT, and for its own installer layout `main.py`
 * sits one level down at `<installPath>/ComfyUI` — the same wrapper shape `config.ts`
 * heals when it detects installs. Our resolved path is the directory that HOLDS main.py,
 * so the two legitimately differ by that one segment. Comparing them naively finds nothing
 * on exactly the Desktop installs this feature exists for, and a silent no-match is
 * indistinguishable here from "no drift" — the sentence would simply never appear.
 */
function identifiesInstall(recorded: string, ours: string): boolean {
  return samePath(recorded, ours) || samePath(join(recorded, "ComfyUI"), ours);
}

/**
 * The saved launch arguments for the install at `installPath`, or undefined when the
 * question could not be answered.
 *
 * UNDEFINED IS "NOT ESTABLISHED", NOT "NONE" (#796). No file, unreadable file, no entry
 * for this path, two entries claiming it, or an entry with no `launchArgs` key are all
 * cases where the caller must stay quiet rather than report an empty set — "Desktop saves
 * no arguments for this install" is a claim, and a missing file does not support it. An
 * entry that explicitly saves an EMPTY string is different: that is a real answer, and it
 * comes back as an empty array.
 */
export function desktopSavedLaunchArgs(installPath: string | undefined): SavedLaunchArgs | undefined {
  if (!installPath?.trim()) return undefined;
  const matches: SavedLaunchArgs[] = [];
  for (const dir of desktopConfigDirs()) {
    let parsed: unknown;
    try {
      const file = join(dir, "installations.json");
      if (!existsSync(file)) continue;
      parsed = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      // Unreadable or malformed: nothing established.
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const inst of parsed) {
      if (!inst || typeof inst !== "object") continue;
      const rec = inst as Record<string, unknown>;
      // A remote entry describes a URL, not a local process — its saved arguments say
      // nothing about the server running here.
      if (rec.sourceId === "remote" || rec.sourceId === "cloud") continue;
      if (typeof rec.installPath !== "string" || !identifiesInstall(rec.installPath, installPath))
        continue;
      // Desktop writes ONE STRING. An array is accepted too rather than assumed away:
      // the shape is theirs to change, and a silent mis-read here would produce a
      // confident sentence about arguments nobody saved.
      const raw = rec.launchArgs;
      const args =
        typeof raw === "string"
          ? raw.split(/\s+/).filter(Boolean)
          : Array.isArray(raw) && raw.every((t) => typeof t === "string")
            ? (raw as string[]).filter(Boolean)
            : undefined;
      if (args === undefined) continue;
      matches.push({
        name: typeof rec.name === "string" && rec.name.trim() ? rec.name : installPath,
        args,
      });
    }
  }
  // AMBIGUITY DECLINES. Two entries claiming the same path cannot both be the install
  // whose settings the user edited, and picking one would put a specific, checkable
  // sentence in front of them that may be about the other.
  return matches.length === 1 ? matches[0] : undefined;
}

/**
 * The sentence naming saved arguments the running server does not have (#848).
 *
 * Returns "" when there is nothing established to say — no saved settings, no running
 * argv, or nothing missing. Silence is the correct output for all three: the caller
 * already prints the general "if you were expecting different arguments" remedy, and this
 * only ever REPLACES a conditional with an observation when one is available.
 *
 * ONLY ABSENCE IS REPORTED, never the reverse. A running server carrying arguments the
 * saved settings do not mention is ordinary — Desktop adds its own — so that direction is
 * not a finding. And the sentence says the tokens are absent, not that the restart
 * dropped them or that Desktop ignored them: neither is observed here.
 */
export function describeSavedLaunchArgDrift(
  saved: SavedLaunchArgs | undefined,
  runningArgv: string[] | undefined,
): string {
  if (!saved || !saved.args.length || !runningArgv?.length) return "";
  const running = new Set(runningArgv);
  const missing = saved.args.filter((tok) => !running.has(tok));
  if (!missing.length) return "";
  return (
    ` ComfyUI Desktop's saved launch settings for "${saved.name}" include ` +
    `${missing.join(" ")}, which the running server's arguments do NOT contain — so that ` +
    `change is not in effect. It is applied when Desktop itself spawns the server: fully ` +
    `quit the ComfyUI Desktop app and relaunch it.`
  );
}
