// #1037 — the UI→API converter dropped a nested DYNAMICCOMBO's non-linked
// siblings whenever one sibling was converted-to-input, and the resulting prompt
// was missing a REQUIRED input. ComfyUI then rejected that output node and
// carried on:
//
//   [ERROR] Failed to validate prompt for output 75:
//   [ERROR]   - Required input is missing: crop
//   [ERROR] Output will be ignored
//   [INFO]  Prompt executed in 1.12 seconds
//
// ...so `queue(action:"status")` reported `success` and no video was produced.
// Two packs we BUNDLE hit this (ltx-2.3-txt2vid, ltx-2.3-img2vid), both via the
// same ResizeImageMaskNode.
//
// The refusal it came from is sound in general: a converted-to-input nested leaf
// may or may not keep a placeholder slot in widgets_values (frontend versions
// differ), and consuming the wrong number shifts a later widget — a seed
// silently becoming a stray `4`. What was missing is that the whole ROW usually
// settles which reading is true:
//
//   ["scale dimensions", 1920, 1088, "center", "lanczos"]     5 slots
//   parent(1) + nested width/height/crop(3) + scale_method(1) = 5  -> retained
//   parent(1) + nested crop(1)             + scale_method(1) = 3  -> omitted ✗
//
// Only one adds up, so `crop` can be read rather than dropped. Where the count
// does NOT settle it, the refusal must survive exactly as it was — that half is
// pinned here just as hard as the fix.

import { describe, expect, it } from "vitest";

import { convertUiToApi } from "../../services/workflow-converter.js";

/** The reporter's node, reduced to the parts that drive the mapping. */
function resizeNodeDef(): Record<string, unknown> {
  return {
    input: {
      required: {
        input: ["IMAGE"],
        resize_type: [
          "COMFY_DYNAMICCOMBO_V3",
          {
            options: [
              {
                key: "scale dimensions",
                inputs: {
                  required: {
                    width: ["INT", { default: 512 }],
                    height: ["INT", { default: 512 }],
                    crop: [["center", "disabled"], { default: "center" }],
                  },
                },
              },
            ],
          },
        ],
        scale_method: [["nearest-exact", "lanczos"], { default: "nearest-exact" }],
      },
    },
  };
}

/** UI graph: width+height converted-to-input (linked), crop still a widget. */
function graphWithLinkedNested(widgetsValues: unknown[]) {
  return {
    nodes: [
      {
        id: 1,
        type: "PrimitiveInt",
        widgets_values: [1920],
        outputs: [{ name: "INT", links: [558] }],
      },
      {
        id: 2,
        type: "PrimitiveInt",
        widgets_values: [1088],
        outputs: [{ name: "INT", links: [559] }],
      },
      {
        id: 343,
        type: "ResizeImageMaskNode",
        widgets_values: widgetsValues,
        inputs: [
          { name: "input", link: null },
          { name: "resize_type.width", link: 558, widget: { name: "resize_type.width" } },
          { name: "resize_type.height", link: 559, widget: { name: "resize_type.height" } },
        ],
      },
    ],
    links: [
      [558, 1, 0, 343, 1, "INT"],
      [559, 2, 0, 343, 2, "INT"],
    ],
  };
}

const OBJECT_INFO = {
  ResizeImageMaskNode: resizeNodeDef(),
  PrimitiveInt: { input: { required: { value: ["INT", { default: 0 }] } } },
} as unknown as Parameters<typeof convertUiToApi>[1];

function convert(widgetsValues: unknown[]) {
  const { workflow, warnings } = convertUiToApi(
    graphWithLinkedNested(widgetsValues) as never,
    OBJECT_INFO,
  );
  return { prompt: workflow as Record<string, { inputs: Record<string, unknown> }>, warnings };
}

describe("#1037: a linked nested sibling no longer drops the rest", () => {
  // THE reported case: placeholders retained, so 5 slots.
  it("emits resize_type.crop instead of omitting it", () => {
    const { prompt } = convert(["scale dimensions", 1920, 1088, "center", "lanczos"]);
    const node = prompt["343"];
    expect(node.inputs["resize_type.crop"]).toBe("center");
  });

  it("still maps the widget that FOLLOWS the combo", () => {
    const { prompt } = convert(["scale dimensions", 1920, 1088, "center", "lanczos"]);
    const node = prompt["343"];
    // The bug dropped this too — everything after the linked leaf was refused.
    expect(node.inputs.scale_method).toBe("lanczos");
  });

  it("does not invent values for the LINKED leaves — the link supplies those", () => {
    const { prompt } = convert(["scale dimensions", 1920, 1088, "center", "lanczos"]);
    const node = prompt["343"];
    // Linked inputs are wired as [nodeId, slot] pairs, never taken from the
    // saved array — a placeholder is stepped over, not read.
    expect(Array.isArray(node.inputs["resize_type.width"])).toBe(true);
    expect(Array.isArray(node.inputs["resize_type.height"])).toBe(true);
  });

  it("stops warning about values it no longer drops", () => {
    const { warnings } = convert(["scale dimensions", 1920, 1088, "center", "lanczos"]);
    expect(warnings.join("\n")).not.toMatch(/can't be positionally resolved/);
  });

  // The OTHER reading: a frontend that omits placeholders serializes 3 slots.
  // Counting settles this one too, in the opposite direction.
  it("handles a frontend that omits the placeholder slots", () => {
    const { prompt } = convert(["scale dimensions", "center", "lanczos"]);
    const node = prompt["343"];
    expect(node.inputs["resize_type.crop"]).toBe("center");
    expect(node.inputs.scale_method).toBe("lanczos");
  });
});

describe("#1037: where counting does NOT settle it, the refusal stands", () => {
  // A row that matches NEITHER reading (4 slots: retained needs 5, omitted 3).
  // Guessing here is exactly how a seed gets a stray value.
  it("refuses an ambiguous row rather than guessing", () => {
    const { prompt, warnings } = convert(["scale dimensions", 1920, 1088, "center"]);
    const node = prompt["343"];
    expect(warnings.join("\n")).toMatch(/can't be positionally resolved/);
    // The saved "center"/"lanczos" are NOT read — that is the refusal working.
    expect(node.inputs.scale_method).not.toBe("lanczos");
  });

  // The asymmetry that made #1037 so hard to spot, pinned so it stays visible.
  //
  // On a refusal a TOP-LEVEL widget falls back to its schema default, which is
  // what the warning's "left to their defaults" describes and is harmless. A
  // NESTED key has no such fallback — nothing fills `resize_type.crop`, so it is
  // simply ABSENT from the prompt, and ComfyUI rejects the node for a missing
  // required input. Same refusal, two very different outcomes.
  it("defaults the top-level widget but leaves the NESTED key absent", () => {
    const { prompt } = convert(["scale dimensions", 1920, 1088, "center"]);
    const node = prompt["343"];
    expect(node.inputs.scale_method).toBe("nearest-exact"); // defaulted: benign
    expect("resize_type.crop" in node.inputs).toBe(false); // absent: fatal
  });

  // The warning is the only signal a user gets on a refusal, and it previously
  // described the benign half of the outcome only.
  it("the warning names the OMITTED nested key, not just 'defaults'", () => {
    const { warnings } = convert(["scale dimensions", 1920, 1088, "center"]);
    const text = warnings.join("\n");
    expect(text).toMatch(/OMITTED from the prompt/);
    expect(text).toMatch(/reject this node and ignore its output/);
    expect(text).toMatch(/report success with nothing produced/);
    // And it no longer claims the whole tail is merely defaulted.
    expect(text).not.toMatch(/are left to their defaults/);
  });

  it("keeps the parent selection even when it refuses the tail", () => {
    const { prompt } = convert(["scale dimensions", 1920, 1088, "center"]);
    const node = prompt["343"];
    expect(node.inputs.resize_type).toBe("scale dimensions");
  });
});
