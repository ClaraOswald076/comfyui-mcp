import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * #848 — reading what ComfyUI Desktop SAVED, so a restart can name what did not take.
 *
 * The fixtures are written as REAL FILES in a temp HOME rather than mocked, because the
 * thing being tested is a file format someone else owns. A hand-built double agrees with
 * whatever I believed the format was, and I believed two wrong things about it before
 * checking: that `launchArgs` was an array (it is one space-separated string) and that
 * `installPath` pointed at the directory holding main.py (it points at the install ROOT,
 * one level up). Both were caught by reading an actual installations.json.
 */
let home = "";

vi.mock("node:os", async (orig) => {
  const real = await orig<typeof import("node:os")>();
  return { ...real, homedir: () => home, default: { ...real, homedir: () => home } };
});

const { desktopSavedLaunchArgs, describeSavedLaunchArgDrift } = await import(
  "../../services/desktop-launch-args.js"
);

/** Write an installations.json into the fake Windows-shaped Desktop config dir. */
const writeInstallations = (entries: unknown): string => {
  const dir = join(home, "AppData", "Roaming", "Comfy Desktop");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "installations.json");
  writeFileSync(file, JSON.stringify(entries), "utf8");
  return file;
};

const localEntry = (installPath: string, extra: Record<string, unknown> = {}) => ({
  id: "inst-1",
  name: "ComfyUI",
  installPath,
  sourceId: "standalone",
  launchArgs: "--enable-manager --enable-cors-header",
  ...extra,
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cmcp-desktop-home-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("#848 — the saved launch arguments", () => {
  it("reads them for the install ROOT and for the directory holding main.py", () => {
    // The shape that actually ships: Desktop records the install root, and its own
    // installer puts ComfyUI one level down. Our resolved path is the main.py directory,
    // so matching only the recorded string finds nothing on exactly the installs this
    // exists for — and a silent no-match is indistinguishable from "no drift".
    const root = join(home, "ComfyUI-Installs", "ComfyUI");
    writeInstallations([localEntry(root)]);

    expect(desktopSavedLaunchArgs(root)?.args).toEqual([
      "--enable-manager",
      "--enable-cors-header",
    ]);
    expect(desktopSavedLaunchArgs(join(root, "ComfyUI"))?.args).toEqual([
      "--enable-manager",
      "--enable-cors-header",
    ]);
    expect(desktopSavedLaunchArgs(root)?.name).toBe("ComfyUI");
  });

  it("returns UNDEFINED — not an empty list — when nothing was established", () => {
    // Three states (#796). "Desktop saves no arguments for this install" is a claim, and a
    // missing or unreadable file does not support it. Reporting an empty set here would
    // let the caller say the settings and the server agree when neither was read.
    const root = join(home, "ComfyUI-Installs", "ComfyUI");

    // No file at all.
    expect(desktopSavedLaunchArgs(root)).toBeUndefined();

    // Unreadable/malformed.
    const dir = join(home, "AppData", "Roaming", "Comfy Desktop");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "installations.json"), "{not json", "utf8");
    expect(desktopSavedLaunchArgs(root)).toBeUndefined();

    // Present, but no entry for this path.
    writeInstallations([localEntry(join(home, "somewhere-else"))]);
    expect(desktopSavedLaunchArgs(root)).toBeUndefined();

    // An entry for this path that saves no launchArgs KEY at all.
    writeInstallations([{ id: "x", name: "ComfyUI", installPath: root, sourceId: "standalone" }]);
    expect(desktopSavedLaunchArgs(root)).toBeUndefined();

    // No path to ask about.
    expect(desktopSavedLaunchArgs(undefined)).toBeUndefined();
    expect(desktopSavedLaunchArgs("   ")).toBeUndefined();
  });

  it("an explicitly EMPTY launchArgs is an answer, not an absence", () => {
    // The one case that is genuinely "none": the user cleared the field. It reads as an
    // empty list, and the drift sentence then has nothing to report — which is different
    // from never having looked.
    const root = join(home, "ComfyUI-Installs", "ComfyUI");
    writeInstallations([localEntry(root, { launchArgs: "" })]);
    expect(desktopSavedLaunchArgs(root)).toEqual({ name: "ComfyUI", args: [] });
  });

  it("ignores remote and cloud entries, whose saved arguments are about nothing local", () => {
    // ONE AT A TIME. Written as two entries together, this passed with the filter
    // DELETED — two matches decline as ambiguous, so the assertion was satisfied by a
    // different rule than the one it names. Mutation testing caught it.
    const root = join(home, "ComfyUI-Installs", "ComfyUI");
    for (const sourceId of ["remote", "cloud"]) {
      writeInstallations([{ ...localEntry(root), sourceId, launchArgs: "--not-local" }]);
      expect(desktopSavedLaunchArgs(root), `${sourceId} must not answer`).toBeUndefined();
    }
    // …and the same file WITH a local entry answers from the local one alone.
    writeInstallations([
      { ...localEntry(root), sourceId: "remote", launchArgs: "--not-local" },
      localEntry(root),
    ]);
    expect(desktopSavedLaunchArgs(root)?.args).toEqual([
      "--enable-manager",
      "--enable-cors-header",
    ]);
  });

  it("DECLINES when two entries claim the same install", () => {
    // They cannot both be the install whose settings the user edited, and picking one puts
    // a specific, checkable sentence in front of them that may be about the other.
    const root = join(home, "ComfyUI-Installs", "ComfyUI");
    writeInstallations([
      localEntry(root, { id: "a", launchArgs: "--one" }),
      localEntry(root, { id: "b", launchArgs: "--two" }),
    ]);
    expect(desktopSavedLaunchArgs(root)).toBeUndefined();
  });

  it("accepts an ARRAY too, rather than assuming the format cannot change", () => {
    const root = join(home, "ComfyUI-Installs", "ComfyUI");
    writeInstallations([localEntry(root, { launchArgs: ["--a", "--b"] })]);
    expect(desktopSavedLaunchArgs(root)?.args).toEqual(["--a", "--b"]);
    // …but not a shape it cannot read. A number is not a quiet empty list.
    writeInstallations([localEntry(root, { launchArgs: 42 })]);
    expect(desktopSavedLaunchArgs(root)).toBeUndefined();
  });
});

describe("#848 — the sentence", () => {
  const saved = { name: "ComfyUI", args: ["--enable-manager", "--disable-dynamic-vram"] };

  it("names the arguments the running server does not have", () => {
    const said = describeSavedLaunchArgDrift(saved, ["main.py", "--enable-manager"]);
    expect(said).toMatch(/--disable-dynamic-vram/);
    // The saved argument that IS present must not be named as missing.
    expect(said).not.toMatch(/--enable-manager,|include --enable-manager/);
    // The remedy is the one thing that applies them, and it is not this tool.
    expect(said).toMatch(/quit the ComfyUI Desktop app and relaunch/);
  });

  it("says NOTHING when there is nothing established", () => {
    // Each of these would otherwise produce a confident sentence about a comparison that
    // never happened — the exact failure #848 reported, pointed the other way.
    expect(describeSavedLaunchArgDrift(undefined, ["main.py"])).toBe("");
    expect(describeSavedLaunchArgDrift(saved, undefined)).toBe("");
    expect(describeSavedLaunchArgDrift(saved, [])).toBe("");
    expect(describeSavedLaunchArgDrift({ name: "x", args: [] }, ["main.py"])).toBe("");
  });

  it("says nothing when every saved argument is in force", () => {
    expect(
      describeSavedLaunchArgDrift(saved, ["main.py", "--enable-manager", "--disable-dynamic-vram"]),
    ).toBe("");
  });

  it("does NOT report the reverse direction", () => {
    // A running server carrying arguments the saved settings do not mention is ordinary —
    // Desktop adds its own — so reporting that would fire on every healthy install.
    expect(
      describeSavedLaunchArgDrift({ name: "ComfyUI", args: ["--enable-manager"] }, [
        "main.py",
        "--enable-manager",
        "--windows-standalone-build",
        "--port",
        "8000",
      ]),
    ).toBe("");
  });
});

describe("#848 — the wiring", () => {
  it("BOTH restart paths append the sentence, and only for Desktop", async () => {
    // A helper nobody calls is worth nothing, and the two restart paths are reached by
    // different callers — the panel tool has its own, the service has the Manager-reboot
    // one. Fixing one and not the other makes the answer depend on which route the user
    // happened to take, which is the shape of half the bugs in this cluster.
    const { readFileSync } = await import("node:fs");
    const code = (rel: string): string =>
      readFileSync(new URL(rel, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*/g, "");

    for (const rel of ["../../services/process-control.ts", "../../orchestrator/panel-tools.ts"]) {
      const src = code(rel);
      expect(src, `${rel} must call it`).toMatch(/describeSavedLaunchArgDrift\(/);
      // Gated on Desktop: a self-spawned Python install has no Desktop settings, and
      // asking about them would attach a sentence about a file that governs nothing here.
      // Anchored on the CALL — the first occurrence is the import — and read as a fixed
      // WINDOW before it. Searching backwards for a literal "isDesktop" instead matched a
      // lowercase occurrence 580 lines away, because the gate here is `preflightIsDesktop`
      // with a capital I; the assertion then measured a distance that meant nothing.
      const callAt = src.lastIndexOf("describeSavedLaunchArgDrift(");
      expect(callAt, `${rel} must call it`).toBeGreaterThan(-1);
      const window = src.slice(Math.max(0, callAt - 300), callAt);
      expect(window, `${rel} must gate the call on Desktop`).toMatch(/[Ii]sDesktop/);
    }
  });
});
