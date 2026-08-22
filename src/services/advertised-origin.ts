/** Public origins for processes running behind a known hosting proxy.
 *
 * These values are display/routing hints, never authorization. Environment
 * variables are treated as untrusted input and invalid values are ignored so a
 * malformed pod id or override cannot turn a local bind into an invented URL.
 */

const RUNPOD_POD_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

export const RUNPOD_LOCAL_COMFYUI_PORT = 3001;

export function runpodPodId(): string | undefined {
  const raw = process.env.RUNPOD_POD_ID?.trim();
  return raw && RUNPOD_POD_ID.test(raw) ? raw : undefined;
}

/** The ComfyUI process port inside the project RunPod image. */
export function localComfyuiPort(defaultPort = 8188): number {
  return runpodPodId() ? RUNPOD_LOCAL_COMFYUI_PORT : defaultPort;
}

function validPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65535;
}

/** An explicit public origin wins over hosting-provider inference. */
export function configuredPublicOrigin(): string | undefined {
  const raw = process.env.COMFYUI_MCP_PUBLIC_URL?.trim();
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (u.username || u.password || u.search || u.hash || !u.hostname) return undefined;
    return u.origin;
  } catch {
    return undefined;
  }
}

/** RunPod's HTTP proxy exposes each explicitly exposed port as `<pod>-<port>`. */
export function runpodProxyOrigin(port: number): string | undefined {
  const pod = runpodPodId();
  return pod && validPort(port) ? `https://${pod}-${port}.proxy.runpod.net` : undefined;
}

/** The origin a user can actually reach for a given listener, if known. */
export function advertisedPublicOrigin(port: number): string | undefined {
  return configuredPublicOrigin() ?? runpodProxyOrigin(port);
}

/** Convert an advertised HTTP(S) origin to the matching WebSocket scheme. */
export function advertisedWebSocketOrigin(port: number): string | undefined {
  const origin = advertisedPublicOrigin(port);
  if (!origin) return undefined;
  const u = new URL(origin);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString().replace(/\/$/, "");
}
