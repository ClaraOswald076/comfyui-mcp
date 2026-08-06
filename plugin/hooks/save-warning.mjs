#!/usr/bin/env node
/**
 * PreToolUse hook for `restart_comfyui`.
 * Prompts the user to confirm before stopping ComfyUI,
 * warning them to save any unsaved workflow changes.
 *
 * Returns permissionDecision: "ask" to show a confirmation dialog.
 *
 * WHY IT READS stdin. 0.50.0 slice 7 folded three tools into `restart_comfyui`,
 * and a hook matcher can only match a tool NAME. Before the fold this hook was
 * matched on `(stop|restart)_comfyui`, so a plain start never prompted; matching
 * the consolidated name alone would prompt "this will stop ComfyUI" on
 * action:"start", which stops nothing. The action IS in the PreToolUse payload,
 * so read it and stay silent for start — a surface consolidation must not invent
 * a confirmation the user never had to answer before.
 *
 * Anything unparseable falls through to ASKING: an unreadable action is not
 * evidence that nothing will be stopped.
 */

let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  let action;
  try {
    action = JSON.parse(input)?.tool_input?.action;
  } catch {
    // Unparseable — fall through and ask.
  }

  if (action === "start") process.exit(0);

  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason:
          "This will stop ComfyUI. Any unsaved workflow changes in the ComfyUI editor will be lost. Make sure your work is saved before proceeding.",
      },
    }),
  );

  process.exit(0);
});
