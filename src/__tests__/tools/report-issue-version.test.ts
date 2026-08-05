// #846 follow-through: the version an agent COPIES out of the ENVIRONMENT line.
//
// The ENV line is prose, and it grew a qualifying clause when the running build and
// the installed one disagree ("comfyui-mcp 0.48.18 (this process is RUNNING 0.48.18;
// 0.49.5 is now installed on disk — …)"). report_issue forwards `mcp_version`
// straight to the triage worker, which version-matches it against the fix history to
// tell the user whether upgrading already resolves their bug — the single most
// common resolution, and exactly what #846 exists to protect. A sentence where a
// version was expected defeats that match silently, and so does the WRONG version.

import { describe, expect, it } from "vitest";
import {
  MCP_VERSION_LABEL,
  PANEL_VERSION_LABEL,
  normalizeReportedVersion,
} from "../../tools/report-issue.js";

const mcp = (raw: string | undefined): string | undefined =>
  normalizeReportedVersion(raw, MCP_VERSION_LABEL);
const panel = (raw: string | undefined): string | undefined =>
  normalizeReportedVersion(raw, PANEL_VERSION_LABEL);

/** The shape the ENVIRONMENT line actually renders, other components and all. */
const ENV_LINE =
  "ENVIRONMENT (live, this machine): Windows 11 · NVIDIA RTX 5090 32GB · torch 2.7.1 · " +
  "python 3.12.3 · ComfyUI 0.30.0 (LOCAL) · Backend: Claude · comfyui-mcp 0.48.18 · panel 0.11.38.";

describe("normalizeReportedVersion (#846)", () => {
  it("passes a plain version through unchanged", () => {
    expect(mcp("0.49.6")).toBe("0.49.6");
    expect(mcp(" 0.49.6 ")).toBe("0.49.6");
    expect(mcp("v0.49.6")).toBe("0.49.6");
    expect(mcp("0.50.0-rc.1")).toBe("0.50.0-rc.1");
  });

  it("reads OUR version out of a whole ENVIRONMENT line, not torch's or python's", () => {
    // The tool description tells the agent to source this field from the env line, so
    // the whole line IS a realistic input. Taking the first semver anywhere returned
    // torch 2.7.1 as the reporter's own version — wrong in a way nothing downstream
    // could detect (codex gate round 2). The LABEL is what makes this correct.
    expect(mcp(ENV_LINE)).toBe("0.48.18");
    expect(panel(ENV_LINE)).toBe("0.11.38");
    expect(mcp(ENV_LINE)).not.toBe("2.7.1");
    expect(mcp(ENV_LINE)).not.toBe("3.12.3");
    expect(mcp(ENV_LINE)).not.toBe("0.30.0");
    // The panel's own label must never be read as ours, and vice versa.
    expect(mcp("comfyui-mcp-panel 0.11.38")).toBeUndefined();
    expect(panel("comfyui-mcp-panel 0.11.38")).toBe("0.11.38");
  });

  it("extracts the RUNNING version from the drift clause, not the installed one", () => {
    // The ENV line leads with the build that is executing, and that is the build the
    // report is about. Taking the LAST version — or the largest — would re-pin the
    // issue to code nobody ran, which is the #846 harm restated.
    const clause =
      "0.48.18 (this process is RUNNING 0.48.18; 0.49.5 is now installed on disk" +
      " — restart the orchestrator to load it, and report bugs against the RUNNING version)";
    expect(mcp(clause)).toBe("0.48.18");

    // …and the form an agent ACTUALLY copies is the whole labelled segment. Matching
    // only at position 0 missed this, fell through to a fresh disk read, and returned
    // the INSTALLED version — reintroducing #846 through the fix for it.
    expect(mcp(`comfyui-mcp ${clause}`)).toBe("0.48.18");
    expect(mcp("mcp=0.49.6")).toBe("0.49.6");
    expect(mcp("comfyui-mcp 0.49.6 · panel 0.11.38")).toBe("0.49.6");
  });

  it("preserves a compact non-semver version instead of swapping in a disk read", () => {
    // A real running version need not be semver. Discarding it would send the caller
    // to detectMcpVersion(), i.e. the INSTALLED number — the same version-swap in a
    // different disguise.
    expect(mcp("nightly")).toBe("nightly");
    expect(mcp("  dev  ")).toBe("dev");
    expect(panel("nightly")).toBe("nightly");
  });

  it("discards prose, so the caller detects a version instead of reporting a sentence", () => {
    expect(mcp("")).toBeUndefined();
    expect(mcp("   ")).toBeUndefined();
    expect(mcp("I could not find the version anywhere")).toBeUndefined();
    expect(mcp(undefined)).toBeUndefined();
    expect(mcp(0.49 as unknown as string)).toBeUndefined();
    // A key=value fragment for some OTHER key is not our version either.
    expect(mcp("torch=2.7.1")).toBeUndefined();
  });
});
