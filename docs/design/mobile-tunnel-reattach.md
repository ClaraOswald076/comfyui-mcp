# Mobile tunnel reattach: decouple the tunnel's lifecycle from the orchestrator's restart

**Status:** draft ask, not scoped for build. Two open decisions below, both owner's call.
**Origin:** artokun, Discord `#help`, 2026-08-08 — "It really is annoying to lose your connection on mobile" / "Can we hold the connection separate from the orchestrator restart group that way we can reattach between updates?"
**Related:** #875 (shipped, `30a838b` — defers the self-restart while a phone is connected), #884 (orchestrator-scoped sessions, shipped — the mechanism this ask leans on)

## The problem, as it stands today

The default mobile transport is a cloudflared **quick tunnel**: no Cloudflare account required, URL is `wss://<random>.trycloudflare.com`, a fresh random hostname **every process run**. `#875` shipped a fix for the resulting disconnect, but it is a *deferral*: the hourly self-restart update check still runs, and while a phone has a live tunnel connection the restart is postponed until the phone disconnects. Updates queue up and land in one shot next time you disconnect.

That is a real fix for the reported symptom (a background update silently killing an in-use session), but it trades "you get disconnected without warning" for "you never get updated while connected" — fine for a short session, worse for someone leaving a tunnel open at work all day, since it means updates never land until they explicitly step away.

## What's being asked instead

Rather than deferring the restart, **let the update apply promptly and give the phone something stable to reconnect to** — so the outage is a brief reconnect blip instead of either (a) a dead URL with no recovery, or (b) updates held off indefinitely.

## What's coupled today (verified against source, not asserted)

- `src/services/tunnel.ts` — `startQuickTunnel()` spawns cloudflared via the `cloudflared` npm package's `Tunnel.quick()`. Nothing detaches it from the Node process.
- `src/services/secure-bridge.ts` — `setupCloudflaredBridge()` adds an explicit safety net: `process.once("exit", () => tunnel.stop())`. This fires on **every** orchestrator exit, restart included, and is what tears the tunnel down today. It exists to avoid a leaked process, not because anything downstream depends on the teardown.

## The part that can't be engineered around

cloudflared tunnels TCP; it does not hold the WebSocket session. **The phone's live connection still terminates the instant the old orchestrator process exits** — that is what a process restart *is*. Nothing here can make the connection itself survive a code-swap restart. What CAN survive is the **hostname** — so instead of the phone holding a dead URL it can never reconnect to, it holds a stable URL it reconnects to within seconds.

That's still a real win, not a smaller one, because of `#884`: sessions are orchestrator-scoped and persisted to `~/.comfyui-mcp/sessions`. A phone reconnecting to the same stable hostname resumes the same conversation automatically — no re-pairing, no lost context.

## Shape of the change

1. Spawn cloudflared **detached**, so it survives the parent process exiting.
2. On the **deliberate self-restart path specifically**, skip the `tunnel.stop()` call. Crash and real-shutdown paths keep killing it — this is not "never clean up", it's "don't clean up on the one path we're choosing to survive".
3. The **new** orchestrator process, on startup, needs to discover the still-running cloudflared process and its hostname rather than spawning a fresh tunnel — some small durable record (pid + URL) written before the restart and read after.
4. The phone side needs to actually retry the same URL on drop rather than surfacing a dead-connection state — check what `comfyui-mcp-mobile`'s `bridge_client.dart` does today on an unexpected close before assuming this needs new mobile-side work.

## Open questions — owner's call, not filled in here

- **Does this replace `#875`'s deferral, or layer on top of it?** Once reattach works, is there still value in deferring a restart while connected (e.g. to avoid the reconnect blip entirely during active use), or does prompt-update-plus-fast-reattach fully replace deferral as the better default?
- **What happens on a genuine crash**, not a deliberate self-restart? A detached tunnel surviving a crash means the *next* orchestrator process needs to find and validate that old tunnel is still healthy before trusting it — a stale/broken tunnel silently accepted would be worse than today's clean-slate-on-restart behavior.

## Explicitly not in scope here

- The relay-backend path (`COMFYUI_MCP_TUNNEL_BACKEND=relay`, self-hosted Worker) is unaffected either way — it's a different mechanism, not addressed by this.
- A real named-cloudflared-tunnel integration (stable hostname by construction, no reattach logic needed) was raised as a separate, larger alternative in the Discord thread and is **not** what's being scoped here.
