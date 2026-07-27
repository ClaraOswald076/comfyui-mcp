# Design: Official Blender adapter (plan)

**Status:** DRAFT / plan-only — no implementation yet. Build after the in-flight
RunPod, LoRA-training, and apps work lands.

**Goal:** an official **Blender add-on** that acts as a *thin host* on the
[third-party host protocol](/third-party-hosts) — so a user can drive their
running ComfyUI agent session from inside Blender, with **one agent and shared
context** (no second Claude Code session, no split brain).

## Why we build it ourselves (rather than wait)

- We can iterate faster than waiting on a community build, and shape it around how
  the first real user (seanmcmagic) wants to use it.
- The community can still build their own via the public protocol docs + the
  copy-paste LLM prompt — this doesn't foreclose that, it sets the reference bar.
- It's a **host**, so it reuses the exact surface the mobile app already ships on;
  the risky/secure parts (pairing, `attach_tab` authoritative stamping) are done.

## What it is — and what it is NOT

| | This adapter (Blender **host**) | Theme H, previz-to-video ([#187](https://github.com/artokun/comfyui-mcp/pull/187)) |
|---|---|---|
| Direction | **Blender → drives the ComfyUI agent** (thin client on `:9182`) | **Agent → drives Blender** (agent calls the official Blender MCP to pose/previz) |
| Relationship | The user's Blender-side cockpit for their agent | A capability the agent reaches out to |
| Overlap | None — complementary. A user can pose a scene via Theme H *and* drive the session from the Blender panel. |

These are two different arrows and should not be conflated. This plan is only the
**host** arrow.

## Architecture

```
Blender add-on (Python)
  ├─ WebSocket client → ws://<desktop-ip>:9182/?token=<PAIR_TOKEN>   (asyncio / websockets)
  ├─ Pairing UX: paste token OR scan/paste the panel's pair URL (user-driven, once)
  ├─ list_tabs → pick a desktop tab → attach_tab
  ├─ Chat dock (bpy UI): input box → user_message ; render streamed agent activity
  └─ Reconnect + mailbox_flush replay
```

- **Language/runtime:** Blender ships Python; use `websockets` (vendored) or a raw
  `asyncio` socket driven from a modal operator / timer so it doesn't block the UI.
- **Protocol:** exactly the frames in [third-party hosts](/third-party-hosts). The
  add-on is `headless: true` (no canvas of its own to advertise).
- **Security invariants preserved verbatim:** user-provided token only, trust
  `tab_attached.ok`, never spoof `tab_id`, attach to non-headless tabs only, one
  attachment per connection. (The add-on submits itself to the same GH
  registration template we ship for third parties.)

## MVP scope (first cut)

1. **Pair + attach.** A panel in Blender's N-sidebar: enter pair URL/token,
   `list_tabs`, pick a tab, `attach_tab`, show connection state.
2. **Chat.** Text input → `user_message`; render the streamed agent replies +
   status inline. This alone delivers "drive my ComfyUI agent from Blender."
3. **Reconnect + replay.** Survive a socket drop; apply `mailbox_flush` on
   re-attach so nothing is lost.

Explicitly **out** of the MVP: rendering interactive A2UI cards, Blender-native
exports/pose-maps (that's Theme H territory), and any agent→Blender control.

## Aligning with Sean's usage

Sean is rebuilding his browser host as a thin client on `:9182` after hitting the
split-brain problem; the Blender add-on is the same shape for a different surface.
Track his thin-client rebuild for the reference client patterns (connection
lifecycle, reconnect, card rendering) and reuse them so the two hosts converge on
one idiom. Where his needs diverge from ours, ours follows the protocol; his can
extend.

## Phasing

1. **Now:** this plan (draft PR) + the shipped [third-party host docs](/third-party-hosts)
   give Sean everything to build his own locally.
2. **After** RunPod / LoRA-training / apps land: implement the MVP above as an
   official `comfyui-mcp-blender` add-on (separate repo, mirrors the mobile
   client's structure).
3. **Later:** richer rendering (A2UI cards in Blender), and optionally wire the
   Theme H agent→Blender-MCP arrow so posing and driving live in one panel.

## Open questions

- **Add-on distribution:** Blender Extensions platform vs. a manual zip — pick the
  path that lets an agent install it (parity with the panel auto-install ethos).
- **Discovery on the same machine:** when Blender and ComfyUI run on one box, can
  we skip the manual token paste by reading the local pair token the way the panel
  does, or does the user always pair explicitly? (Lean explicit for security.)
- **Card rendering fidelity:** how much of the A2UI card set is worth rendering in
  bpy vs. degrading to text — defer past MVP.
