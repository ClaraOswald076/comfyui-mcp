# docker-compose example — ComfyUI as a service

A minimal compose setup for running **ComfyUI** in a container and driving it
with `comfyui-mcp`. Full explanation:
[docs → Docker & Compose](https://comfyui-mcp.artokun.io/docs/docker).

## The one thing to understand

**`comfyui-mcp` is not in the compose file — on purpose.** It is a *stdio* MCP
server: it has no port, and the MCP client (Claude Code, Cursor, a bridge, …)
spawns it as a child process over stdin/stdout. A `comfyui-mcp` compose service
would have nothing to talk to and exit. What goes in compose is **ComfyUI**;
the MCP server runs wherever your MCP client runs and connects to ComfyUI over
HTTP via `COMFYUI_URL`.

## Usage

```bash
docker compose up -d
```

Then add the MCP server to your client config (e.g. `~/.claude/settings.json`
for Claude Code — requires **Node.js >= 22** on that machine):

```json
{
  "mcpServers": {
    "comfyui": {
      "command": "npx",
      "args": ["-y", "comfyui-mcp@latest"],
      "env": {
        "COMFYUI_URL": "http://localhost:8188"
      }
    }
  }
}
```

If the MCP client runs **inside another compose service** on the same network
(e.g. an MCP bridge for Open WebUI), use the service name instead of
localhost:

```
COMFYUI_URL=http://comfyui:8188
```

## GPU variants

The compose file defaults to NVIDIA (`yanwk/comfyui-boot:cu130-slim-v2`, a
third-party community image). For **AMD/ROCm**, switch the image to
`yanwk/comfyui-boot:rocm` and uncomment the ROCm passthrough block
(`devices`, `group_add`, `security_opt`) — comments in
[`docker-compose.yml`](./docker-compose.yml) walk through it. `comfyui-mcp`
itself has no GPU/CUDA dependency.

> `docker/runpod` in this repo is a **CUDA-oriented RunPod cloud image**, not a
> general-purpose ComfyUI image — don't start from it for a local or AMD setup.

## Volumes

Bind mounts under `./storage/` persist models, custom nodes, outputs, and user
workflows on the host across container rebuilds. Layout follows the image's
docs (`/root/ComfyUI`).
