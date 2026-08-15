// #1454 — an incomplete template list read as a complete one.
//
// `list_templates` consults exactly one source: the connected ComfyUI's
// `/api/workflow_templates`. That reports what packs REGISTER, and a pack can ship
// example workflows on disk without registering them — the reporter had
// `ComfyUI-LTXVideo/example_workflows/2.5/*.json` present while the pack did not
// appear at all, and fell back to searching the filesystem by hand.
//
// Nothing in the reply said that was possible. `source_count: 4` reads as "there are
// four", so a caller concludes the workflow does not exist rather than that this
// index cannot see it.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  TEMPLATE_INDEX_SCOPE_NOTE,
  templateIndexScopeNote,
} from "../../services/template-index-scope.js";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("#1454 what the note says", () => {
  it("names the authority the index actually reflects", () => {
    // Without the mechanism this is just hedging, and a reader has no reason to
    // believe a 53-template answer could be missing their pack.
    // Case-insensitive: a control mutation lowercasing the word killed the strict
    // form, which punishes rewording rather than protecting the claim.
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/registers/i);
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/\/api\/workflow_templates/);
  });

  it("refuses the 'absent means it has none' reading outright", () => {
    // The exact wrong conclusion the reporter was pushed toward.
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/without registering them/i);
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/not evidence it has no templates/i);
  });

  it("names WHERE the invisible ones live, and how to use one", () => {
    // A caveat with no next step is just doubt. This is the search the reporter had
    // to work out unaided.
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/custom_nodes\/<pack>\/example_workflows/);
    expect(TEMPLATE_INDEX_SCOPE_NOTE).toMatch(/by path/);
  });

  it("does NOT claim to have scanned the disk", () => {
    // It has not. Implying otherwise would be a worse defect than the one being
    // fixed — a caller would treat a still-incomplete list as exhaustive.
    expect(TEMPLATE_INDEX_SCOPE_NOTE).not.toMatch(/scanned|searched the disk|includes on-disk/i);
  });

  it("stays short enough to be read", () => {
    // It rides on every successful listing; a paragraph is skipped, and a skipped
    // caveat protects nobody.
    expect(TEMPLATE_INDEX_SCOPE_NOTE.length).toBeLessThan(500);
  });
});

describe("#1454 when it attaches", () => {
  it("attaches to EVERY listing, not only an empty one", () => {
    // Gating on emptiness would hide it in exactly the reported case: 4 sources,
    // 53 templates, and the one they wanted absent. The gap is not "the list is
    // empty", it is "the list is one authority's view".
    expect(templateIndexScopeNote()).toBe(TEMPLATE_INDEX_SCOPE_NOTE);
    expect(templateIndexScopeNote().length).toBeGreaterThan(0);
  });
});

describe("#1454 WIRING: the reply carries it", () => {
  const src = readFileSync(join(HERE, "../../tools/skills-access.ts"), "utf8");

  /**
   * The reply object that contains `needle`, bounded by its OWN braces.
   *
   * This used to be `src.slice(at, at + 600)`, and a fixed byte window is a trap
   * this repo has now sprung four times: the window says nothing about the code,
   * so any legitimate insertion ABOVE the field being asserted pushes that field
   * out of frame and the test fails for a reason unrelated to what it checks.
   * #1415 added two fields and a four-line comment between the counts and
   * `index_scope`, and that alone turned this red. Widening the number would only
   * move the cliff. Bounding by the enclosing literal cannot drift.
   */
  function enclosingObject(source: string, needle: string): string {
    const at = source.indexOf(needle);
    expect(at, `the wiring anchor ${JSON.stringify(needle)} is gone`).toBeGreaterThan(-1);
    // Walk back to the `{` that opens the object this field sits in.
    let depth = 0;
    let start = -1;
    for (let i = at; i >= 0; i--) {
      const c = source[i];
      if (c === "}") depth++;
      else if (c === "{") {
        if (depth === 0) {
          start = i;
          break;
        }
        depth--;
      }
    }
    expect(start, "no opening brace above the anchor").toBeGreaterThan(-1);
    // …and forward to the brace that closes it.
    depth = 0;
    for (let i = start; i < source.length; i++) {
      const c = source[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return source.slice(start, i + 1);
      }
    }
    throw new Error("unterminated object literal around the wiring anchor");
  }

  it("list_templates emits index_scope alongside the counts", () => {
    // The behavioural tests cannot see the reply shape, and a note nothing attaches
    // is the defect this repo keeps paying for.
    expect(src).toMatch(
      /import \{ templateIndexScopeNote \} from "\.\.\/services\/template-index-scope\.js";/,
    );
    expect(enclosingObject(src, "source_count: groups.length")).toMatch(
      /index_scope: templateIndexScopeNote\(\)/,
    );
  });

  it("the counts are still reported — the note adds, it does not replace", () => {
    const block = enclosingObject(src, "source_count: groups.length");
    expect(block).toMatch(/template_count: total/);
    expect(block).toMatch(/templates: index/);
  });
});
