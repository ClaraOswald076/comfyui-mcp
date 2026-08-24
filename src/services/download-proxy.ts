import { execFile } from "node:child_process";
import { isIP } from "node:net";
import { platform } from "node:os";
import { promisify } from "node:util";
import { EnvHttpProxyAgent, ProxyAgent, type Dispatcher } from "undici";
import { assertHostResolvesSafe, isBlockedHost } from "./workflow-url.js";
import { logger } from "../utils/logger.js";

export type DownloadRoute = "direct" | "proxied";

type FetchInput = Parameters<typeof fetch>[0];
type FetchInit = Parameters<typeof fetch>[1];

export type DownloadFetch = (input: FetchInput, init?: FetchInit) => Promise<Response>;

const execFileAsync = promisify(execFile);
const WINDOWS_INTERNET_SETTINGS = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const WINDOWS_PROXY_QUERY_TIMEOUT_MS = 1_000;
const PROXY_DNS_CHECK_TIMEOUT_MS = 1_000;

interface ProxyChoice {
  route: DownloadRoute;
  dispatcher?: Dispatcher;
}

interface ProxyState {
  choose(url: URL): ProxyChoice | Promise<ProxyChoice>;
}

interface ProxyOverrides {
  proxyEnable: boolean;
  proxyServer?: string;
  proxyOverride?: string;
  autoConfigUrl?: string;
  autoDetect?: boolean;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function envValue(lower: string, upper: string): string | undefined {
  // This is the precedence EnvHttpProxyAgent documents: lowercase wins when
  // both spellings are present.
  return nonEmpty(process.env[lower]) ?? nonEmpty(process.env[upper]);
}

function urlForInput(input: FetchInput): URL | undefined {
  try {
    if (typeof input === "string" || input instanceof URL) return new URL(String(input));
    if (input && typeof input === "object" && "url" in input) {
      const value = (input as { url?: unknown }).url;
      return typeof value === "string" ? new URL(value) : undefined;
    }
  } catch {
    // Let fetch produce the canonical invalid-URL error. Invalid input is never
    // given a proxy dispatcher here.
  }
  return undefined;
}

function normalizedHost(hostname: string): string {
  return hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
}

/** Internal and non-public targets are always direct. A local ComfyUI API must
 * not inherit a model-download proxy merely because the two requests share this
 * process, and a corporate proxy must not become an SSRF path to private hosts. */
export function isDirectLocalHost(hostname: string): boolean {
  return isBlockedHost(normalizedHost(hostname));
}

/** Only a target proven public may use a configured proxy. A DNS failure is
 * deliberately direct/fail-closed: the proxy must never be asked to resolve an
 * unknown hostname on our behalf. Every redirect hop calls this again through
 * the download fetch seam. */
async function shouldBypassProxy(url: URL): Promise<boolean> {
  const host = normalizedHost(url.hostname);
  if (isDirectLocalHost(host)) return true;
  if (isIP(host) !== 0) return false;
  try {
    await assertHostResolvesSafe(host, PROXY_DNS_CHECK_TIMEOUT_MS);
    return false;
  } catch (error) {
    logger.debug("Could not prove that a model-download host is public; using a direct route.", {
      host,
      error: error instanceof Error ? error.message : String(error),
    });
    return true;
  }
}

function noProxyHostAndPort(value: string): { host: string; port?: string } {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close >= 0) {
      return { host: trimmed.slice(1, close), port: trimmed.slice(close + 1).replace(/^:/, "") || undefined };
    }
  }
  const colon = trimmed.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(trimmed.slice(colon + 1))) {
    return { host: trimmed.slice(0, colon), port: trimmed.slice(colon + 1) };
  }
  return { host: trimmed };
}

function matchesNoProxy(url: URL, value: string | undefined): boolean {
  if (!value) return false;
  const host = normalizedHost(url.hostname);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  for (const rawEntry of value.split(/[;,\s]+/)) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    if (entry === "<local>") {
      if (!host.includes(".")) return true;
      continue;
    }
    if (entry.startsWith("<") && entry.endsWith(">")) continue;
    const parsed = noProxyHostAndPort(entry.replace(/^\.+/, ""));
    if (parsed.port && parsed.port !== port) continue;
    const pattern = parsed.host.replace(/^\*\./, "");
    if (host === pattern || host.endsWith(`.${pattern}`)) return true;
  }
  return false;
}

function normalizeProxyUrl(raw: string): string {
  const value = raw.trim();
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `http://${value}`;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`unsupported proxy protocol ${parsed.protocol}`);
  }
  return parsed.toString();
}

export function parseProxyServer(raw: string | undefined): { http?: string; https?: string } {
  const out: { http?: string; https?: string } = {};
  for (const part of (raw ?? "").split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    const scheme = equals < 0 ? undefined : trimmed.slice(0, equals).trim().toLowerCase();
    const endpoint = (equals < 0 ? trimmed : trimmed.slice(equals + 1)).trim();
    if (!endpoint || (scheme && scheme !== "http" && scheme !== "https")) continue;
    let normalized: string;
    try {
      normalized = normalizeProxyUrl(endpoint);
    } catch {
      continue;
    }
    if (!scheme || scheme === "http") out.http = normalized;
    if (!scheme || scheme === "https") out.https = normalized;
  }
  return out;
}

async function proxyChoiceForStatic(
  url: URL,
  agents: { http?: Dispatcher; https?: Dispatcher },
  noProxy: string | undefined,
): Promise<ProxyChoice> {
  if (matchesNoProxy(url, noProxy) || (await shouldBypassProxy(url))) return { route: "direct" };
  const dispatcher = url.protocol === "https:" ? agents.https : agents.http;
  return dispatcher ? { route: "proxied", dispatcher } : { route: "direct" };
}

function parseRegistryProxy(stdout: string): ProxyOverrides {
  const values: ProxyOverrides = { proxyEnable: false };
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^\s*(ProxyEnable|ProxyServer|ProxyOverride|AutoConfigURL|AutoDetect)\s+REG_\w+\s+(.+?)\s*$/i.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === "proxyenable") values.proxyEnable = /^0x0$|^0$/i.test(value) ? false : /^0x1$|^1$/i.test(value);
    else if (key === "proxyserver") values.proxyServer = value;
    else if (key === "proxyoverride") values.proxyOverride = value;
    else if (key === "autoconfigurl") values.autoConfigUrl = value;
    else if (key === "autodetect") values.autoDetect = /^0x1$|^1$/i.test(value);
  }
  return values;
}

async function readWindowsSystemProxy(): Promise<ProxyOverrides | undefined> {
  if (platform() !== "win32") return undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  try {
    const query = execFileAsync("reg.exe", ["query", WINDOWS_INTERNET_SETTINGS], {
      windowsHide: true,
      maxBuffer: 32 * 1024,
      signal: controller.signal,
    });
    const deadline = new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => {
          controller.abort();
          reject(new Error(`registry query timed out after ${WINDOWS_PROXY_QUERY_TIMEOUT_MS}ms`));
        },
        WINDOWS_PROXY_QUERY_TIMEOUT_MS,
      );
    });
    const result = await Promise.race([query, deadline]);
    return parseRegistryProxy(String(result.stdout));
  } catch (error) {
    logger.debug("Could not read the Windows WinINet proxy settings; using direct model downloads.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function directState(): ProxyState {
  return { choose: () => ({ route: "direct" }) };
}

function envProxyState(): ProxyState | undefined {
  const httpProxy = envValue("http_proxy", "HTTP_PROXY");
  const httpsProxy = envValue("https_proxy", "HTTPS_PROXY");
  const noProxy = envValue("no_proxy", "NO_PROXY");
  if (!httpProxy && !httpsProxy) return undefined;
  try {
    const dispatcher = new EnvHttpProxyAgent({
      httpProxy,
      httpsProxy,
      noProxy,
    });
    return {
      choose: async (url) => {
        const configuredProxy = url.protocol === "https:" ? (httpsProxy ?? httpProxy) : httpProxy;
        return (
          matchesNoProxy(url, noProxy) ||
          (await shouldBypassProxy(url)) ||
          !configuredProxy
        )
          ? { route: "direct" }
          : { route: "proxied", dispatcher };
      },
    };
  } catch (error) {
    logger.warn("Ignoring invalid HTTP proxy environment settings for model downloads.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function loadProxyState(): Promise<ProxyState> {
  const explicit = nonEmpty(process.env.COMFYUI_DOWNLOAD_PROXY);
  if (explicit) {
    try {
      const dispatcher = new ProxyAgent(normalizeProxyUrl(explicit));
      return {
        choose: async (url) =>
          (await shouldBypassProxy(url)) ? { route: "direct" } : { route: "proxied", dispatcher },
      };
    } catch (error) {
      logger.warn("Ignoring invalid COMFYUI_DOWNLOAD_PROXY; model downloads will use a direct route.", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const env = envProxyState();
  if (env) return env;

  const windows = await readWindowsSystemProxy();
  if (!windows?.proxyEnable || !windows.proxyServer) {
    if (windows?.autoConfigUrl || windows?.autoDetect) {
      logger.debug("Windows WinINet uses PAC/auto-detect without a static proxy; model downloads stay direct.");
    }
    return directState();
  }
  const parsed = parseProxyServer(windows.proxyServer);
  if (!parsed.http && !parsed.https) return directState();
  try {
    const agents = {
      http: parsed.http ? new ProxyAgent(parsed.http) : undefined,
      https: parsed.https ? new ProxyAgent(parsed.https) : undefined,
    };
    return { choose: (url) => proxyChoiceForStatic(url, agents, windows.proxyOverride) };
  } catch (error) {
    logger.warn("Ignoring invalid Windows WinINet proxy settings for model downloads.", {
      error: error instanceof Error ? error.message : String(error),
    });
    return directState();
  }
}

let proxyStatePromise: Promise<ProxyState> | undefined;

async function chooseProxy(input: FetchInput): Promise<ProxyChoice> {
  const url = urlForInput(input);
  if (!url) return { route: "direct" };
  proxyStatePromise ??= loadProxyState();
  return (await proxyStatePromise).choose(url);
}

/** Create a download-only fetch wrapper. It never changes undici's global
 * dispatcher, so ComfyUI API calls continue to use their existing route. */
export function createDownloadFetch(onRoute?: (route: DownloadRoute) => void): DownloadFetch {
  return async (input, init) => {
    const choice = await chooseProxy(input);
    onRoute?.(choice.route);
    const { dispatcher: _callerDispatcher, ...withoutDispatcher } = init ?? {};
    // Node's global fetch and the direct undici dependency can expose distinct
    // Dispatcher type copies. The runtime contract is the same; keep the
    // compatibility cast at this one boundary rather than leaking it into every
    // download fetch seam.
    const routedInit =
      choice.route === "proxied" && choice.dispatcher
        ? { ...withoutDispatcher, dispatcher: choice.dispatcher }
        : withoutDispatcher;
    return globalThis.fetch(input, routedInit as FetchInit);
  };
}

export const downloadFetch: DownloadFetch = createDownloadFetch();

export async function downloadRouteForUrl(input: FetchInput): Promise<DownloadRoute> {
  return (await chooseProxy(input)).route;
}

/** Test-only reset for the lazy system/config probe. No production caller should
 * need to refresh it during a process lifetime. */
export const __downloadProxyTestHooks = {
  reset(): void {
    proxyStatePromise = undefined;
  },
  matchesNoProxy,
  parseRegistryProxy,
};
