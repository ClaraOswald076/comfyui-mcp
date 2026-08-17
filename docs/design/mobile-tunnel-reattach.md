# Mobile tunnel reattach: decouple the tunnel's lifecycle from the orchestrator's restart

**Status:** draft ask, not scoped for build. Two open decisions below, both owner's call.
**Origin:** artokun, Discord `#help`, 2026-08-08 — "It really is annoying to lose your connection on mobile" / "Can we hold the connection separate from the orchestrator restart group that way we can reattach between updates?"
**Related:** #875 (shipped, in three parts — see below), #884 (orchestrator-scoped sessions, shipped — the mechanism this ask leans on)
**Re-verified against source:** 2026-08-14, against `origin/main`. Every "verified" claim below was re-read on that date. **One claim in the original draft was wrong and is corrected in place** — see "What's coupled today".

## The problem, as it stands today

Phone pairing offers two transports: `lan` (`ws://<lan-ip>:<pairPort>/?token=…`, same wifi) and `tunnel` (anywhere). The tunnel option is **always** a cloudflared **quick tunnel** — no Cloudflare account required, URL is `wss://<random>.trycloudflare.com`, and the hostname is minted fresh **every process run** with no way to pin it.

`#875` has shipped, and it shipped more than the "deferral" this draft originally credited it with. Three separate things landed:

- **`65058e2` (#1113) — the pairing token stopped rotating.** It is now persisted to `~/.comfyui-mcp/pair-token` (mode 0600, write-then-rename) instead of being minted per run — `src/orchestrator/pair-token-store.ts`. A **LAN** pairing URL therefore already survives a restart with no configuration.
- **`1764e2a` (#1020) — pair-time disclosure.** `src/orchestrator/pair-durability.ts` tells the user, at the moment the URL is minted, which parts of it rotate on a restart and what to do about it.
- **`30a838b` (#1115) — the deferral.** While a phone is connected over a tunnel, the automatic update-restart is postponed until it disconnects.

**This is what makes the ask below narrower than it looks.** With the token stable, the quick-tunnel **hostname is the last remaining rotating part** of a tunnel pairing URL. `pair-token-store.ts` says so in its own header: *"This is HALF the fix … a stable token makes the LAN URL durable and a tunnel URL still rotates."* This document is the other half.

The deferral is a real fix for the reported symptom (a background update silently killing an in-use session), but it trades "you get disconnected without warning" for "you never get updated while connected" — fine for a short session, worse for someone leaving a tunnel open at work all day. That cost is disclosed rather than hidden: `pair-durability.ts`'s tunnel note states at pair time that "a tunnel left connected indefinitely therefore postpones updates indefinitely".

## What's being asked instead

Rather than deferring the restart, **let the update apply promptly and give the phone something stable to reconnect to** — so the outage is a brief reconnect blip instead of either (a) a dead URL with no recovery, or (b) updates held off indefinitely.

## What's coupled today (verified 2026-08-14 — CORRECTED)

> **Correction.** The original draft named `src/services/secure-bridge.ts` → `setupCloudflaredBridge()` as "what tears the tunnel down today", under a heading claiming it was verified against source. **That is the wrong path for this ask, and it was wrong when the draft was written** — `secure-bridge.ts` is the `connect`-path remote-pod bridge, not phone pairing. The pairing tunnel has lived in `src/orchestrator/index.ts` since `5129663` (#180), long predating this draft. A build scoped from that sentence would have edited a file the phone never touches and changed nothing.

There are **two independent quick-tunnel call sites**. This ask is about the first:

1. **Phone pairing — the one this is about.** `src/orchestrator/index.ts`, in the `pair` event handler: `startQuickTunnel(pairPort, "127.0.0.1")`, cached in the `pairTunnel` local, with its teardown registered right there — `process.once("exit", () => pairTunnel?.stop())`. This is what dies on a restart and takes the phone's URL with it.
2. **The `connect` path's remote-pod bridge.** `src/services/secure-bridge.ts` → `setupCloudflaredBridge()`, using the same helper, with its own `process.once("exit", () => tunnel.stop())` plus a `stop()` on the returned handle. A different consumer with a different user; not the phone's problem, but it would need the same treatment if the change is made general rather than pairing-only.

Common to both: `src/services/tunnel.ts` — `startQuickTunnel()` spawns cloudflared via the `cloudflared` npm package's `Tunnel.quick()`. Nothing detaches it from the Node process, and **`Tunnel.quick()` exposes no detach option at all** (see "Shape of the change" #1).

One more fact from `pair-durability.ts` worth carrying here: `COMFYUI_MCP_TUNNEL_BACKEND=relay` is read **only** by `secure-bridge.ts`. The pairing path calls `startQuickTunnel()` directly and never consults it, so a relay operator gets exactly the same rotating trycloudflare hostname as everyone else.

## How the deferral is actually wired (verified 2026-08-14)

Worth knowing before touching it, because it is **not** in the restarter:

- `src/services/self-restart.ts` knows nothing about tunnels. It takes an `allIdle()` dependency and fires an armed restart only when that returns true (plus a `MIN_UPTIME_MS` floor).
- `src/orchestrator/index.ts` folds the tunnel gate into that dependency as one clause: `!tunnelPairingLive()`, where `tunnelPairingLive()` is `pairTunnel !== null && bridge.hasLiveHeadlessClient()`.
- The `&&` is deliberate and load-bearing: a tunnel that merely *exists* defers nothing, or a single pairing would postpone every future update forever. It defers only while a client is connected **right now**.
- "Hourly" applies to **published** installs (`DEFAULT_UPDATE_CHECK_MS`, overridable with `COMFYUI_MCP_UPDATE_CHECK_MS`). Dev/linked installs restart on a rebuild instead (entry-mtime watch, ~10 s); an "unknown" install mode disables periodic checks entirely.

## The part that can't be engineered around

cloudflared tunnels TCP; it does not hold the WebSocket session. **The phone's live connection still terminates the instant the old orchestrator process exits** — that is what a process restart *is*. Nothing here can make the connection itself survive a code-swap restart. What CAN survive is the **hostname** — so instead of the phone holding a dead URL it can never reconnect to, it holds a stable URL it reconnects to within seconds.

That's still a real win, not a smaller one, because of `#884`: sessions are orchestrator-scoped and persisted to `~/.comfyui-mcp/sessions` (`src/orchestrator/session-store.ts`). A phone reconnecting to the same stable hostname resumes the same conversation automatically — no re-pairing, no lost context.

## Shape of the change

**None of the below is implemented as of 2026-08-14** (there is no detached cloudflared spawn anywhere in `src/`, and no durable tunnel record). Nothing here has been rejected either.

1. Spawn cloudflared **detached**, so it survives the parent process exiting. **This is not a flag.** `startQuickTunnel()` delegates the spawn to the `cloudflared` package's `Tunnel.quick()` (a mechanic adapted from Ungate), which owns the child process and offers no `detached` option — so this means replacing that call with our own `spawn(…, { detached: true }).unref()` and re-implementing the `url` / `stderr` / `error` / `exit` event handling that `startQuickTunnel` is built on. Scope it accordingly; it is not a one-liner.
2. On the **deliberate self-restart path specifically**, skip the teardown. For the pairing tunnel that means the `process.once("exit", …)` registered inside `index.ts`'s `pair` handler — *not* the one in `secure-bridge.ts`. Crash and real-shutdown paths keep killing it; this is not "never clean up", it's "don't clean up on the one path we're choosing to survive".
3. The **new** orchestrator process, on startup, needs to discover the still-running cloudflared process and its hostname rather than spawning a fresh tunnel — some small durable record (pid + URL) written before the restart and read after. It would sit alongside the two records that already exist for exactly this reason: `~/.comfyui-mcp/pair-token` and `~/.comfyui-mcp/sessions`.
4. ~~The phone side needs to actually retry the same URL on drop rather than surfacing a dead-connection state — check what `comfyui-mcp-mobile`'s `bridge_client.dart` does today.~~ **Checked (2026-08-14). No new mobile-side retry mechanism is needed — but there is a catch that changes this item.**
   `comfyui-mcp-mobile`'s `lib/core/bridge/bridge_client.dart` already re-dials the *same* URL after an unintentional drop (its own `#37`): backoff 1/2/4/8/16/30 s, and the ladder resets only once a connection has *survived* a probation timer, so a flapping host keeps climbing.
   **The catch:** it is capped at `_maxRetries = 6` (~1 minute), and the cap's stated justification is precisely the assumption this document proposes to remove — that the hostname "is regenerated every orchestrator run — so after a restart the old URL is permanently dead and retrying it forever would spin against a host that will never answer". Make the hostname stable and that cap becomes the binding constraint: a restart that takes longer than ~61 s to rebind drops the phone into the terminal give-up state anyway, which is the outcome this whole document exists to avoid.
   So item 4 is **not** "check what it does" but "**revisit `_maxRetries` and the comment justifying it, in the mobile repo, as part of this change**".

## Open questions — owner's call, not filled in here

- **Does this replace `#875`'s deferral, or layer on top of it?** Once reattach works, is there still value in deferring a restart while connected (e.g. to avoid the reconnect blip entirely during active use), or does prompt-update-plus-fast-reattach fully replace deferral as the better default? Mechanically either answer is a small edit: the deferral is the single `!tunnelPairingLive()` clause in `index.ts`'s `allIdle`.
- **What happens on a genuine crash**, not a deliberate self-restart? A detached tunnel surviving a crash means the *next* orchestrator process needs to find and validate that old tunnel is still healthy before trusting it — a stale/broken tunnel silently accepted would be worse than today's clean-slate-on-restart behavior.

## Explicitly not in scope here

- The relay-backend path (`COMFYUI_MCP_TUNNEL_BACKEND=relay`, self-hosted Worker) is unaffected either way. Sharper than "a different mechanism": per `pair-durability.ts` it is **not reachable from the pairing path at all**, so it cannot be offered to a phone user as a workaround either.
- A real named-cloudflared-tunnel integration (stable hostname by construction, no reattach logic needed) was raised as a separate, larger alternative in the Discord thread and is **not** what's being scoped here.
