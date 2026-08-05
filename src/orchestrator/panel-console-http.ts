// Loopback HTTP console for MCP / orchestrator settings (control plane).
//
// The ComfyUI sidebar panel stays a canvas-focused client: provider, effort,
// context, storyboards. Service lifecycle, OAuth, MCP mappings, and advanced
// tool suites live here — opened from the panel's Advanced → "Open MCP Console".
//
// Bound to 127.0.0.1 only; never exposed off-host.

import { createReadStream, existsSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { allBackendReadiness } from "./backend-readiness.js";
import { getLoraCatalog, loraPreviewsDir } from "../services/lora-catalog.js";
import {
  setPanelSecret,
  clearPanelSecret,
  envFilePath as envStorePath,
  listPanelSecretsMasked,
  receiptDisclosures,
  removeDisclosures,
  revokeIsClean,
  slotRevokeState,
  slotSaveConfirmed,
  slotShellProvidedKeys,
  unconfirmedSlotKeys,
  CREDENTIAL_SLOTS,
} from "../services/panel-secrets.js";
import { OPENAI_KEY_PROVIDER_IDS } from "../services/openai-provider-registry.js";
import { logger } from "../utils/logger.js";

// The simple api-key providers (glm/kimi/moonshot) are spliced in from the
// openai-provider-registry so a new one appears here by adding a registry entry.
const KNOWN_BACKENDS: string[] = [
  "claude",
  "codex",
  "chatgpt",
  "gemini",
  "antigravity",
  "grok",
  ...OPENAI_KEY_PROVIDER_IDS,
  "ollama",
  "copilot", // EXPERIMENTAL — see orchestrator/index.ts's copilotModel comment
];

export interface PanelConsoleHttpServer {
  readonly port: number;
  readonly url: string;
  stop(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
  });
  res.end(html);
}

const FRAME_ANCESTORS = "frame-ancestors http://127.0.0.1:8188 http://localhost:8188 'self'";
function sendFramedHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
    "Cache-Control": "no-store",
    "Content-Security-Policy": FRAME_ANCESTORS,
  });
  res.end(html);
}

function tokenOk(req: IncomingMessage, expected?: string): boolean {
  if (!expected) return true; // no token configured → open (dev)
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const q = url.searchParams.get("token");
    const h = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "");
    return q === expected || h === expected;
  } catch { return false; }
}

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    let oversized = false;
    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };
    req.on("data", (c) => {
      if (oversized) return; // already over limit: drain and discard the rest, don't destroy mid-stream
      data += c;
      if (data.length > 1_000_000) {
        oversized = true;
        data = "";
        settle(() => reject(new Error("body too large")));
      }
    });
    req.on("end", () => { settle(() => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); } }); });
    req.on("error", (e) => { settle(() => reject(e)); });
    req.on("close", () => { settle(() => reject(new Error("request closed before body was fully received"))); });
  });
}

const PREVIEW_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

function serveLoraPreview(req: IncomingMessage, res: ServerResponse): void {
  let id = "";
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    id = (url.searchParams.get("id") ?? "").trim();
  } catch {
    sendJson(res, 400, { ok: false, error: "bad request" });
    return;
  }
  if (!id) {
    sendJson(res, 400, { ok: false, error: "id required" });
    return;
  }
  const catalog = getLoraCatalog();
  const entry = catalog.get(id);
  if (!entry?.previewFile) {
    sendJson(res, 404, { ok: false, error: "no preview" });
    return;
  }
  const previewsRoot = resolve(loraPreviewsDir());
  const abs = resolve(join(previewsRoot, entry.previewFile));
  // Path containment: use the platform separator (sep) so the check also holds
  // on Windows, where resolve() yields backslash-separated paths.
  if (!abs.startsWith(previewsRoot + sep) && abs !== previewsRoot) {
    sendJson(res, 403, { ok: false, error: "invalid preview path" });
    return;
  }
  if (!existsSync(abs)) {
    sendJson(res, 404, { ok: false, error: "preview file missing" });
    return;
  }
  const mime = PREVIEW_MIME[extname(abs).toLowerCase()] ?? "application/octet-stream";
  res.writeHead(200, {
    "Content-Type": mime,
    "Cache-Control": "private, max-age=3600",
  });
  createReadStream(abs).pipe(res);
}

function consoleLandingHtml(opts: {
  bridgePort: number;
  consolePort: number;
  comfyuiUrl: string;
}): string {
  const { bridgePort, consolePort, comfyuiUrl } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>ComfyUI MCP Console</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #0f1115; color: #e8eaed; line-height: 1.5; }
    main { max-width: 52rem; margin: 0 auto; padding: 2rem 1.25rem 3rem; }
    h1 { font-size: 1.35rem; font-weight: 600; margin: 0 0 0.25rem; }
    .sub { color: #9aa0a6; font-size: 0.9rem; margin-bottom: 1.5rem; }
    section { background: #181b22; border: 1px solid #2a2f3a; border-radius: 10px; padding: 1rem 1.1rem; margin-bottom: 1rem; }
    h2 { font-size: 0.95rem; margin: 0 0 0.6rem; color: #c4c7ce; }
    ul { margin: 0.4rem 0 0; padding-left: 1.2rem; }
    li { margin: 0.25rem 0; }
    code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 0.82rem; }
    pre { background: #0b0d11; border: 1px solid #2a2f3a; border-radius: 8px; padding: 0.75rem; overflow-x: auto; }
    .ok { color: #81c995; }
    .warn { color: #fdd663; }
    a { color: #8ab4f8; }
    #status { font-size: 0.85rem; }
  </style>
</head>
<body>
  <main>
    <h1>ComfyUI MCP Console</h1>
    <p class="sub">Control plane for the panel orchestrator — MCP servers, OAuth, and service settings. The ComfyUI sidebar panel stays focused on chat, providers, and the live canvas.</p>

    <section>
      <h2>Connection</h2>
      <p>Bridge <code>ws://127.0.0.1:${bridgePort}</code> · ComfyUI <code>${escapeHtml(comfyuiUrl)}</code></p>
      <p id="status">Loading provider readiness…</p>
    </section>

    <section>
      <h2>Coming here (panel stays in ComfyUI)</h2>
      <ul>
        <li>Start / stop / restart orchestrator</li>
        <li>MCP server mappings &amp; inherited <code>~/.claude.json</code> tools</li>
        <li>OAuth &amp; API provider sign-in</li>
        <li>LoRA library, image collections, Photomap-style tooling</li>
        <li>A2UI-rich tool surfaces</li>
      </ul>
    </section>

    <section>
      <h2>Stays in the ComfyUI panel</h2>
      <ul>
        <li>Provider / model / effort pickers &amp; context window meter</li>
        <li>Video storyboards &amp; live graph edits</li>
        <li>Connect / Disconnect to this bridge</li>
      </ul>
    </section>

    <section>
      <h2>API</h2>
      <pre>GET /api/status</pre>
    </section>
  </main>
  <script>
    fetch('/api/status').then(r => r.json()).then(d => {
      const el = document.getElementById('status');
      const rows = (d.backends || []).map(b =>
        b.backend + ': ' + (b.ready ? 'ready' : (b.cli ? 'sign in' : 'install CLI'))
      ).join(' · ');
      el.innerHTML = '<span class="ok">Orchestrator running</span> — ' + (rows || 'no backends');
    }).catch(() => {
      document.getElementById('status').innerHTML = '<span class="warn">Could not load status</span>';
    });
  </script>
</body>
</html>`;
}

function credentialsHtml(
  slots: { id: string; label: string; help?: string }[],
  consoleUrl: string,
  token: string,
): string {
  const rows = slots
    .map(
      (s) => `      <div class="row" data-slot="${escapeHtml(s.id)}">
        <div class="meta"><span class="label">${escapeHtml(s.label)}</span>${s.help ? `<span class="help">${escapeHtml(s.help)}</span>` : ""}</div>
        <div class="state"><span class="badge" data-badge>—</span></div>
        <div class="entry"><input type="password" placeholder="Paste key…" data-input autocomplete="off" spellcheck="false" /><button data-save>Save</button></div>
      </div>`,
    )
    .join("\n");
  const cfg = JSON.stringify({ consoleUrl, token });
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>API Keys</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui, -apple-system, Segoe UI, sans-serif; }
    body { margin: 0; background: #0f1115; color: #e8eaed; }
    main { padding: 0.9rem 1rem 1.2rem; }
    header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.75rem; }
    h1 { font-size: 1.05rem; font-weight: 600; margin: 0; }
    .close { background: none; border: none; color: #9aa0a6; font-size: 1.1rem; cursor: pointer; }
    .row { display: grid; grid-template-columns: 1fr auto; gap: 0.35rem 0.6rem; padding: 0.6rem 0; border-bottom: 1px solid #23272f; }
    .meta { display: flex; flex-direction: column; }
    .label { font-size: 0.9rem; font-weight: 500; }
    .help { font-size: 0.72rem; color: #9aa0a6; }
    .state { grid-column: 2; align-self: center; }
    .badge { font-size: 0.72rem; color: #9aa0a6; }
    .badge.set { color: #81c995; }
    .entry { grid-column: 1 / -1; display: flex; gap: 0.4rem; }
    input { flex: 1; background: #0b0d11; border: 1px solid #2a2f3a; border-radius: 7px; color: #e8eaed; padding: 0.4rem 0.5rem; font-size: 0.82rem; }
    button { background: #2a3140; border: 1px solid #3a4150; color: #e8eaed; border-radius: 7px; padding: 0.4rem 0.7rem; font-size: 0.82rem; cursor: pointer; }
    button:hover { background: #333c4d; }
    button[data-save].ok { color: #81c995; border-color: #2f6b41; }
    footer { margin-top: 0.9rem; display: flex; justify-content: space-between; align-items: center; }
    .advanced { background: none; border: 1px solid #2a2f3a; color: #8ab4f8; }
    .err { color: #f28b82; font-size: 0.75rem; }
  </style>
</head>
<body>
  <main>
    <header><h1>API Keys</h1><button class="close" data-close title="Close">✕</button></header>
    <div id="rows">
${rows}
    </div>
    <p class="err" id="err"></p>
    <footer>
      <span class="help">Stored locally, per instance. Values never leave this machine.</span>
      <button class="advanced" data-advanced>Advanced ↗</button>
    </footer>
  </main>
  <script>
    const CFG = ${cfg};
    const q = (t) => "?token=" + encodeURIComponent(t);
    function postHeight() {
      try { parent.postMessage({ type: "resize", height: document.body.scrollHeight }, "*"); } catch {}
    }
    async function load() {
      try {
        const r = await fetch("/api/secrets" + q(CFG.token));
        const d = await r.json();
        for (const s of (d.slots || [])) {
          const row = document.querySelector('.row[data-slot="' + s.id + '"]');
          if (!row) continue;
          const badge = row.querySelector("[data-badge]");
          badge.textContent = s.set ? "set · " + s.masked : "not set";
          badge.classList.toggle("set", !!s.set);
        }
      } catch (e) { document.getElementById("err").textContent = "Could not load status — reconnect the panel."; }
      postHeight();
    }
    document.querySelectorAll(".row").forEach((row) => {
      const btn = row.querySelector("[data-save]");
      const input = row.querySelector("[data-input]");
      btn.addEventListener("click", async () => {
        const value = input.value.trim();
        if (!value) return;
        btn.disabled = true; btn.textContent = "Saving…";
        try {
          const r = await fetch("/api/secrets" + q(CFG.token), {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ slot: row.dataset.slot, value }),
          });
          const d = await r.json();
          if (!r.ok || !d.ok) throw new Error(d.error || "save failed");
          input.value = "";
          const badge = row.querySelector("[data-badge]");
          badge.textContent = "set · " + d.masked; badge.classList.add("set");
          btn.textContent = "Saved ✓"; btn.classList.add("ok");
          setTimeout(() => { btn.textContent = "Save"; btn.classList.remove("ok"); btn.disabled = false; }, 1500);
        } catch (e) {
          document.getElementById("err").textContent = String(e.message || e);
          btn.textContent = "Save"; btn.disabled = false;
        }
      });
    });
    document.querySelector("[data-close]").addEventListener("click", () => { try { parent.postMessage({ type: "close" }, "*"); } catch {} });
    document.querySelector("[data-advanced]").addEventListener("click", () => { window.open(CFG.consoleUrl + "/console", "_blank", "noopener"); });
    window.addEventListener("load", load);
    new ResizeObserver(postHeight).observe(document.body);
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function startPanelConsoleHttpServer(opts: {
  port: number;
  host?: string;
  bridgePort: number;
  comfyuiUrl: string;
  token?: string;
}): Promise<PanelConsoleHttpServer> {
  const host = opts.host ?? "127.0.0.1";

  // The panel calls /api/secrets from the ComfyUI page origin (e.g.
  // http://127.0.0.1:8188 → this console's port), which is CROSS-origin — without
  // CORS headers the browser hard-fails the fetch ("Couldn't load credentials")
  // even though the request itself is loopback + token-gated. Allow exactly the
  // ComfyUI origin (plus its localhost↔127.0.0.1 twin, since the page may be
  // open under either name). Never "*": the token would otherwise be callable
  // from any web page the user has open.
  const allowedOrigins = new Set<string>();
  try {
    const u = new URL(opts.comfyuiUrl);
    const twins = new Set([u.hostname, u.hostname === "localhost" ? "127.0.0.1" : "localhost"]);
    for (const h of twins) allowedOrigins.add(`${u.protocol}//${h}${u.port ? `:${u.port}` : ""}`);
  } catch {
    allowedOrigins.add("http://127.0.0.1:8188");
    allowedOrigins.add("http://localhost:8188");
  }

  const server: Server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    if (req.method === "OPTIONS") {
      // Preflight for the authorized JSON POST (Authorization + content-type).
      res.writeHead(204, {
        "Access-Control-Allow-Methods": "GET, POST",
        "Access-Control-Allow-Headers": "authorization, content-type",
        "Access-Control-Max-Age": "600",
      });
      res.end();
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/api/secrets") {
      if (!tokenOk(req, opts.token)) { sendJson(res, 401, { ok: false, error: "unauthorized" }); return; }
      if (req.method === "GET") { sendJson(res, 200, { ok: true, slots: listPanelSecretsMasked() }); return; }
      if (req.method === "POST") {
        let body: any;
        try { body = await readJsonBody(req); } catch { sendJson(res, 400, { ok: false, error: "bad json" }); return; }
        const slot = String(body?.slot ?? "");
        const value = String(body?.value ?? "");
        const clear = body?.clear === true;
        if (!slot || (!value && !clear)) {
          sendJson(res, 400, { ok: false, error: "slot and value required (or clear: true to revoke)" });
          return;
        }
        try {
          if (clear) {
            // Revoke path (issue #203): remove every alias key of the slot, then
            // VERIFY the slot no longer resolves. Reporting `cleared:true` from
            // "a line was removed" alone would call the credential revoked while
            // another form of the assignment still supplies it (codex gate,
            // round 3, finding 2).
            // Captured BEFORE the clear: keys a real environment variable
            // supplies come back on the next start, so the revoke is only
            // effective for this process and must not be reported as complete.
            const shellKeys = slotShellProvidedKeys(slot);
            const clearOutcome = clearPanelSecret(slot);
            const removed = clearOutcome.changed;
            // The removal ALREADY HAPPENED. Anything it cost is disclosed here,
            // with `ok:false` so no UI can render it as a clean revoke — it is
            // never re-thrown, because the previous version's throw became a
            // generic `ok:false` in the catch below and the caller retried a
            // removal that had already run, against a store that had already
            // lost keys (codex gate).
            // Everything the removal owes the caller — lost keys, an incomplete
            // loss account, dropped comments, a write that is not crash-durable,
            // a legacy purge that failed. Built from the one shared list, not
            // from this endpoint's own idea of which fields matter, and computed
            // BEFORE any branch returns: the damage branch used to return in
            // front of this and in front of the end-state check, so a revoke that
            // lost keys reported neither its other obligations nor whether the
            // credential still resolves (codex gate).
            const clearWarnings = removeDisclosures(clearOutcome, envStorePath());
            const state = slotRevokeState(slot);
            if (clearOutcome.lostKeys.length) {
              sendJson(res, 500, {
                ok: false,
                slot,
                cleared: removed,
                lost_keys: clearOutcome.lostKeys,
                // The verified end state, which this branch skipped entirely.
                still_resolves: state === "unknown" ? null : state === "still-resolves",
                ...(clearWarnings.length ? { warnings: clearWarnings } : {}),
                error:
                  `"${slot}" WAS removed from the credential store, but the store no longer carries ${clearOutcome.lostKeys.join(", ")} — ` +
                  `${clearOutcome.lostKeys.length > 1 ? "those credentials were" : "that credential was"} lost during the rewrite. ` +
                  `Do NOT repeat the revoke: it already happened, and another write would rewrite an already-damaged store. Inspect the file and restore the missing entries first.`,
              });
              return;
            }
            if (state === "still-resolves") {
              sendJson(res, 500, {
                ok: false,
                slot,
                cleared: false,
                still_resolves: true,
                error:
                  `Removed an entry for "${slot}", but the credential still resolves — something else is still providing it. It is NOT revoked.`,
              });
              return;
            }
            if (state === "unknown") {
              // The store could not be read, so we cannot say the credential is
              // gone: a tool process that CAN read it may still find the old
              // value there. Report the uncertainty instead of either verdict.
              //
              // `ok:false`, deliberately. The warning below said the end state
              // was UNKNOWN while the success flag next to it said the revoke
              // worked — and a consumer reads the flag (codex gate). This is a
              // DISCLOSURE, not a refusal: `cleared` still reports that the
              // removal happened, so nobody is invited to retry it.
              sendJson(res, 500, {
                ok: false,
                slot,
                cleared: removed,
                still_resolves: null,
                warning:
                  `"${slot}" no longer applies to this process, but the credential store could not be re-read, so whether it is gone from disk is UNKNOWN. ` +
                  `A tool session that can read the store may still find the old value. Re-check before relying on the revoke.`,
                ...(clearWarnings.length ? { warnings: clearWarnings } : {}),
              });
              return;
            }
            // `ok` asks the same question everywhere: is this a CLEAN revoke?
            // The end state being verified "gone" is not enough — a revoke whose
            // loss account was never completed, that the boot migration will
            // undo, or that only partly ran was green-lit here while a warning
            // beside it said exactly that, and a consumer reads the flag
            // (codex gate). Comment loss and a durability gap stay warnings:
            // they are what the revoke COST, not doubt about the revoke.
            const cleanRevoke = revokeIsClean(clearOutcome);
            sendJson(res, cleanRevoke ? 200 : 500, {
              ok: cleanRevoke,
              slot,
              // `cleared` keeps its established meaning — an entry was removed
              // from the credential STORE — and `still_resolves` reports the
              // verified end state. Two fields, each true to its own question:
              // conflating them is how `cleared:false` ended up sitting next to
              // a "cleared for this session" note (codex gate, round 4,
              // finding 5).
              cleared: removed,
              // Scoped claim: it no longer resolves HERE. A tool session that
              // was already running keeps the value it was spawned with until it
              // is rebuilt — the clear schedules that rebuild, it does not
              // perform it, so the two are reported separately.
              still_resolves: false,
              live_sessions_rebuild_at_idle: true,
              ...(shellKeys.length
                ? {
                    warning:
                      `${shellKeys.join(", ")} ${shellKeys.length > 1 ? "are" : "is"} set as a real environment variable outside this app, not in the credential store. ` +
                      `It no longer applies to the running process, but it returns on the next start — unset it where it is defined to revoke it permanently.`,
                  }
                : {}),
              ...(clearWarnings.length ? { warnings: clearWarnings } : {}),
            });
            return;
          }
          // Report what the read-back PROVED, not that the call returned. The
          // same failure panel_request_secret refuses was answered ok:true here.
          const outcome = setPanelSecret(slot, value);
          if (!slotSaveConfirmed(outcome)) {
            // DATA LOSS FIRST. This endpoint answered `200 {ok:true, masked}`
            // from `slotSaveConfirmed` alone, so a save that destroyed the
            // user's other tokens was reported to the panel as a clean success —
            // the PR's original defect, one layer further out (codex gate). It
            // cannot recur by omission now: a damaged receipt is `persisted:
            // "damaged"`, which is not "yes", so `confirmed` is false and this
            // branch is the only way out.
            if (outcome.lostKeys.length) {
              // Say which post-state we are ACTUALLY in. "Nothing was rolled
              // back" was asserted unconditionally here, but this branch is also
              // reached when a FAILED save rolled back and the rollback is what
              // lost the keys — so it stated a post-state that had not happened
              // (codex gate). `rolledBack` is the outcome's own answer.
              const rollbackNote = outcome.receipts.some((r) => r.persisted === "damaged")
                ? `Nothing was rolled back: a rollback cannot bring them back and would be one more rewrite of a damaged store.`
                : outcome.rolledBack
                  ? `The slot itself was rolled back, but that rollback is what the store lost these entries during — it cannot be undone by repeating it.`
                  : `The slot was NOT left in its previous state either; see stranded_keys / unverified_restore_keys.`;
              sendJson(res, 500, {
                ok: false,
                slot,
                // Key NAMES only — never a value.
                lost_keys: outcome.lostKeys,
                saved_but_damaged: true,
                rolled_back: outcome.rolledBack,
                ...(outcome.strandedKeys.length ? { stranded_keys: outcome.strandedKeys } : {}),
                ...(outcome.unverifiedKeys.length
                  ? { unverified_restore_keys: outcome.unverifiedKeys }
                  : {}),
                ...(outcome.restoreWarnings?.length ? { warnings: outcome.restoreWarnings } : {}),
                error:
                  `"${slot}" was written to the credential store, but the store no longer carries ${outcome.lostKeys.join(", ")} — ` +
                  `${outcome.lostKeys.length > 1 ? "those credentials were" : "that credential was"} lost during the write. This is NOT a successful save. ` +
                  `${rollbackNote} ` +
                  `Inspect the file and restore the missing ${outcome.lostKeys.length > 1 ? "entries" : "entry"} before relying on anything in it.`,
              });
              return;
            }
            const unconfirmed = unconfirmedSlotKeys(outcome.receipts);
            const failed = unconfirmed.filter((u) => u.persisted === "no");
            // Describe the state we LEFT, not the state we intended. A slot with
            // alias keys is written serially, so a failure part-way can leave an
            // earlier alias live; `strandedKeys` names exactly that case, and
            // "nothing was half-applied" is only claimed when the restore is
            // proven complete.
            const stranded = outcome.strandedKeys;
            const unverifiedRestore = outcome.unverifiedKeys;
            const aftermath = stranded.length
              ? `Restoring the slot did not take effect for ${stranded.join(", ")}, which still carr${stranded.length > 1 ? "y" : "ies"} the new value — the slot is in a MIXED state; set it again, or clear it, before relying on it.`
              : unverifiedRestore.length
                ? `Restoring the slot could NOT be verified for ${unverifiedRestore.join(", ")} (the store was unreadable), so whether anything was half-applied is unknown — re-check before relying on it.`
                : `The change was rolled back, so nothing was half-applied.`;
            // `unknown` is NOT a success. Answering 200 ok:true for a write
            // whose read-back could not be performed asserts a definite
            // configured state from a failed verification — the #826 shape
            // reappearing inside the vocabulary introduced to prevent it
            // (coordinator finding). `ok` is true only for a PROVEN save, which
            // this branch is not, by construction.
            const unverifiedSave = unconfirmed.filter((u) => u.persisted === "unknown");
            sendJson(res, 500, {
              ok: false,
              slot,
              // Key NAMES and verdicts only — never a value.
              unconfirmed,
              rolled_back: outcome.rolledBack,
              ...(unverifiedSave.length ? { unverified_keys: unverifiedSave.map((u) => u.key) } : {}),
              ...(stranded.length ? { stranded_keys: stranded } : {}),
              ...(unverifiedRestore.length ? { unverified_restore_keys: unverifiedRestore } : {}),
              // What the ROLLBACK's own writes cost — a rollback is a store
              // write the user never asked for, and it was reported nowhere.
              ...(outcome.restoreWarnings?.length ? { warnings: outcome.restoreWarnings } : {}),
              ...(failed.length
                ? {
                    error:
                      `"${slot}" was NOT saved: the credential store does not come back carrying ${failed.map((f) => f.key).join(", ")}. ${aftermath}`,
                  }
                : stranded.length
                  ? { error: `"${slot}" could not be saved cleanly. ${aftermath}` }
                  : {
                      // The REASON comes from the receipt. "unknown" no longer
                      // means only "the file could not be re-read" — it also
                      // covers a save whose key read back fine but whose loss
                      // account a concurrent writer made impossible to complete,
                      // and asserting the wrong one sends the user to check the
                      // wrong thing (codex gate).
                      error:
                        `"${slot}" was written but the save is NOT confirmed (${unconfirmed.map((u) => u.key).join(", ")}), so treat it as UNKNOWN: ` +
                        `${outcome.receipts.find((r) => r.uncertainty)?.uncertainty ?? "the store could not be re-read to confirm it"}. ` +
                        `Do not treat it as configured. ${aftermath}`,
                    }),
            });
            return;
          }
          const masked = listPanelSecretsMasked().find((s) => s.id === slot)?.masked ?? null;
          // A CONFIRMED save can still owe the user a disclosure — comment lines
          // the rewrite dropped, or a write that could not be made crash-durable.
          // Built from the one shared list, so a new obligation on the receipt
          // reaches this endpoint without anyone remembering to wire it up here.
          const warnings = [
            ...outcome.receipts.flatMap((r) => receiptDisclosures(r)),
            // A confirmed slot save performs no rollback, so this is normally
            // empty — but it is included from the same place either way, so the
            // rollback's own costs can never be the field nobody rendered.
            ...(outcome.restoreWarnings ?? []),
          ];
          sendJson(res, 200, {
            ok: true,
            slot,
            masked,
            ...(warnings.length ? { warnings } : {}),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          sendJson(res, /unknown credential slot/i.test(msg) ? 400 : 500, { ok: false, error: msg });
        }
        return;
      }
      sendJson(res, 405, { ok: false, error: "method not allowed" });
      return;
    }
    if (req.method === "GET" && path === "/api/status") {
      const { backends, any_ready } = allBackendReadiness(KNOWN_BACKENDS);
      const bound = server.address();
      const boundPort =
        bound && typeof bound === "object" ? bound.port : opts.port;
      const liveUrl = `http://${host}:${boundPort}`;
      sendJson(res, 200, {
        ok: true,
        console_url: liveUrl,
        bridge_port: opts.bridgePort,
        bridge_url: `ws://${host}:${opts.bridgePort}`,
        comfyui_url: opts.comfyuiUrl,
        backends,
        any_ready,
      });
      return;
    }
    if (req.method === "GET" && path === "/api/lora-preview") {
      serveLoraPreview(req, res);
      return;
    }
    if (req.method === "GET" && path === "/credentials") {
      if (!tokenOk(req, opts.token)) { sendHtml(res, 401, "<p>Unauthorized — reconnect the panel.</p>"); return; }
      const bound = server.address();
      const boundPort = bound && typeof bound === "object" ? bound.port : opts.port;
      sendFramedHtml(res, 200, credentialsHtml(CREDENTIAL_SLOTS, `http://${host}:${boundPort}`, opts.token ?? ""));
      return;
    }
    if (req.method === "GET" && (path === "/" || path === "/console")) {
      sendHtml(
        res,
        200,
        consoleLandingHtml({
          bridgePort: opts.bridgePort,
          consolePort: opts.port,
          comfyuiUrl: opts.comfyuiUrl,
        }),
      );
      return;
    }
    sendJson(res, 404, { ok: false, error: "not_found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, host, () => {
      server.removeListener("error", reject);
      const bound = server.address();
      const boundPort =
        bound && typeof bound === "object" ? bound.port : opts.port;
      const url = `http://${host}:${boundPort}`;
      logger.info(`[panel-console] MCP console listening on ${url} (loopback)`);
      resolve({
        port: boundPort,
        url,
        stop: () =>
          new Promise((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}