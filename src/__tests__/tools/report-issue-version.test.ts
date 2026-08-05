// #846 follow-through: the version an agent COPIES out of the ENVIRONMENT line.
//
// The ENV line is prose, and it grew a qualifying clause when the running build and
// the installed one disagree ("comfyui-mcp 0.48.18 (this process is RUNNING 0.48.18;
// 0.49.5 is now installed on disk — …)"). report_issue forwards `mcp_version`
// straight to the triage worker, which version-matches it against the fix history to
// tell the user whether upgrading already resolves their bug — the single most
// common resolution, and exactly what #846 exists to protect. A sentence where a
// version was expected defeats that match silently.

import { describe, expect, it } from "vitest";
import { normalizeReportedVersion } from "../../tools/report-issue.js";

describe("normalizeReportedVersion (#846)", () => {
  it("passes a plain version through unchanged", () => {
    expect(normalizeReportedVersion("0.49.6")).toBe("0.49.6");
    expect(normalizeReportedVersion(" 0.49.6 ")).toBe("0.49.6");
    expect(normalizeReportedVersion("v0.49.6")).toBe("0.49.6");
    expect(normalizeReportedVersion("0.50.0-rc.1")).toBe("0.50.0-rc.1");
  });

  it("extracts the RUNNING version from the drift clause, not the installed one", () => {
    // The ENV line leads with the build that is executing, and that is the build
    // the report is about. Taking the LAST version in the string — or the largest —
    // would re-pin the issue to code nobody ran, which is the #846 harm restated.
    const clause =
      "0.48.18 (this process is RUNNING 0.48.18; 0.49.5 is now installed on disk" +
      " — restart the orchestrator to load it, and report bugs against the RUNNING version)";
    expect(normalizeReportedVersion(clause)).toBe("0.48.18");

    // …and the form an agent ACTUALLY copies is the whole labelled segment. Matching
    // only at position 0 missed this, fell through to a fresh disk read, and returned
    // the INSTALLED version — reintroducing #846 through the fix for it.
    expect(normalizeReportedVersion(`comfyui-mcp ${clause}`)).toBe("0.48.18");
    expect(normalizeReportedVersion("mcp=0.49.6")).toBe("0.49.6");
    expect(normalizeReportedVersion("comfyui-mcp 0.49.6 · panel 0.11.38")).toBe("0.49.6");
  });

  it("preserves a compact non-semver version instead of swapping in a disk read", () => {
    // A real running version need not be semver. Discarding it would send the caller
    // to detectMcpVersion(), i.e. the INSTALLED number — the same version-swap in a
    // different disguise.
    expect(normalizeReportedVersion("nightly")).toBe("nightly");
    expect(normalizeReportedVersion("  dev  ")).toBe("dev");
  });

  it("discards prose, so the caller detects a version instead of reporting a sentence", () => {
    expect(normalizeReportedVersion("")).toBeUndefined();
    expect(normalizeReportedVersion("   ")).toBeUndefined();
    expect(normalizeReportedVersion("I could not find the version anywhere")).toBeUndefined();
    expect(normalizeReportedVersion(undefined)).toBeUndefined();
    expect(normalizeReportedVersion(0.49 as unknown as string)).toBeUndefined();
  });
});
