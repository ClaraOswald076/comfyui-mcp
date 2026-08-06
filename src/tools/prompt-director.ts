import { comfyuiFetch } from "../comfyui/fetch.js";


function comfyBase(): string {
  return (
    process.env.COMFYUI_URL ||
    (process.env.COMFYUI_PORT ? `http://127.0.0.1:${process.env.COMFYUI_PORT}` : "http://127.0.0.1:8188")
  ).replace(/\/$/, "");
}


/**
 * `get_workflow (action:"prompt_director")` — the body of the retired
 * Prompt Director inspection tool, verbatim (0.50.0 slice 14). Same
 * `/prompt_director/inspection` request, same optional `node_id` query, same
 * pretty-printed JSON content block.
 *
 * Throws instead of returning `errorToToolResult` — including on a non-OK HTTP
 * status, where it throws the SAME `Error` the old tool handed to
 * `errorToToolResult` directly. The caller wraps every action in the identical
 * catch, so both paths render exactly the result they always did.
 */
export async function promptDirectorInspectAction(
  nodeId?: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const query = nodeId ? `?node_id=${encodeURIComponent(nodeId)}` : "";
  const response = await comfyuiFetch(`${comfyBase()}/prompt_director/inspection${query}`);
  if (!response.ok) {
    throw new Error(
      `Prompt Director inspection HTTP ${response.status}. Is ComfyUI running with ComfyUI-PromptDirector loaded?`,
    );
  }
  const payload = await response.json();
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}
