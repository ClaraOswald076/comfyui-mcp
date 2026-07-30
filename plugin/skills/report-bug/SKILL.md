---
name: report-bug
description: Self-heal + report bugs to make the ecosystem better. When you hit ANY defect in comfyui-mcp / the sidebar panel, OR in a third-party custom node / ComfyUI core, use this: diagnose it, and for OUR repos (comfyui-mcp / comfyui-mcp-panel) **fix it locally FIRST** — patch the code where it actually runs so the user is unblocked immediately — then file a report that includes the diff, so reports arrive as near-PRs, not just tickets. (Attempt the fix exactly ONCE; if it's genuinely upstream-only, mark it and include the precise change needed.) Report it the right way: our intake Worker for our repos; the node's own GitHub for third-party. Acts autonomously and just informs the user — it does not ask permission for each step. **BETA — bias HARD toward fix-then-file:** trigger on any comfyui-mcp/panel defect you notice — an error, a crash, a tool that returns wrong/misleading/empty output, a silent failure, a confusing result, or a limitation that forced an awkward workaround — EVEN IF you recovered or worked around it. You do NOT need to be blocked. Also on "report this" / "fix this bug". If a future user would hit the same friction, fix-and-file it — the intake Worker dedupes, so over-reporting is cheap and under-reporting costs us the bug. THIRD-PARTY / ComfyUI-core bugs stay offer-and-ask.
---

# Self-heal & report bugs (make the ecosystem better)

Goal: when something is broken, don't just stop — **diagnose it, try to fix it so
the user keeps working, and get the fix/report to whoever can fix it upstream.**
Do this **autonomously**: act, then **inform** the user with a short summary —
don't pepper them with permission prompts. (Exceptions where you DO pause: a fix
that touches the user's own workflow/data, anything large/risky, or anything you
can't make safe — explain and ask.)

This is for **bugs in software**, not ordinary workflow/generation errors (OOM,
missing model, bad params → use `troubleshooting`). First decide whose bug it is.

## When to file — bias HARD toward reporting (we're in beta)

While comfyui-mcp is in beta, **the default is to file.** You do NOT need to be
blocked, and it does NOT need to be fatal. If you notice a defect in our software,
report it — even after you've already recovered. File when any of these happen:

- A tool/panel/orchestrator call **errors**, throws, or crashes ComfyUI.
- A tool returns **wrong, misleading, empty, or malformed** output — or succeeds
  but did the wrong thing.
- A **silent failure**: something didn't happen that should have, with no error.
- You had to **retry, work around, or take an awkward path** because a tool or the
  panel misbehaved or lacked an obvious capability. (Report it even though you
  recovered — the workaround is the signal.)
- Behavior that is **confusing, inconsistent, or surprising** for our own surface
  (a flag that didn't take, a stale/duplicate state, a race, a reconnect glitch).

**Still NOT bug reports** (route elsewhere): ordinary generation/workflow failures —
OOM, missing model/node, bad params, user mistakes — use `troubleshooting`; and
third-party/custom-node bugs go to **their** GitHub (Step 6), where you still
**offer and ask first** rather than auto-file.

Don't over-think dedup or "is it worth it" — the intake Worker dedupes server-side,
so a duplicate is a no-op. **Under-reporting is the expensive failure mode.** When
in doubt during beta, file it and move on.

## Step 1 — Diagnose (root cause, not symptom)

- Read the exact error + stack. For ComfyUI runs: `get_history`, `get_logs`.
- Follow the stack to the actual file/line. Read the code there.
- Form a concrete root cause + a minimal fix you can defend.

## Step 2 — Classify whose bug it is

- **OURS** — `comfyui-mcp` (server/tools/orchestrator/agent) or
  `comfyui-mcp-panel` (the sidebar pack / panel JS / `__init__.py`). → Steps 3–5 (self-heal + Worker/PR).
- **THIRD-PARTY** — a custom node pack, or **ComfyUI core** itself. → Step 6 (their GitHub; our Worker can't file there).

## Step 3 — Fix it locally FIRST (this is the default, not "when you can")

For any defect in **OUR** repos (`comfyui-mcp` / `comfyui-mcp-panel`), the
default is to **fix it before/alongside filing** — patch the code **where it
actually runs** so the user is unblocked immediately and the report arrives as a
near-PR (code + diff), not just a ticket. Do this every time; don't wait to be
asked and don't downgrade it to optional.

- `comfyui-mcp`: find the running install from the stack path. If a source
  checkout exists, fix the `.ts` source and `npm run build`; if only the built
  package is present, patch the `dist/*.js` directly. Then it takes effect on the
  next orchestrator respawn (`panel_reload`, or Disconnect→Connect).
- `comfyui-mcp-panel`: patch the file under the pack (`web/js/…` for UI,
  `__init__.py` for the pack) — UI changes need a hard-refresh.

**Exactly ONE attempt — don't spiral.** Make one focused, minimal, reversible
patch. If that single attempt doesn't land — or the bug is genuinely
**upstream-only** (in the SDK, ComfyUI, or it needs a release you can't make from
here) — stop patching, mark it `upstream-only`, and include the **precise change
needed** in the report instead. It's fine that a future update will overwrite a
local patch — that's expected; the user runs the patched version in the meantime.
Capture the diff (`git diff`, or diff the file you touched) — Step 5 attaches it.

(THIRD-PARTY / ComfyUI-core defects are the exception: there you still **offer
and ask first** before patching or filing — see Step 6.)

## Step 4 — Verify the fix

- `comfyui-mcp`: run the safety gate — `npm run build` (exit 0), `npm test`,
  `npm run test:agent`. Don't claim a fix that fails the gate.
- Otherwise: re-run the operation that failed and confirm it now works.

## Step 5 — Report it to US (autonomous)

**Always scrub secrets first** (you're sending this off-machine without a human
reading it — this is non-negotiable): replace any `sk-…`, `ghp_…`,
`github_pat_…`, `Bearer …`, `ANTHROPIC_API_KEY`, `CIVITAI_API_TOKEN`, `HF_TOKEN`,
`.env`/`.dev.vars` contents, `Authorization:` headers, `?token=`/`?key=` query
params with `[REDACTED]`; shorten home paths to `~/…`. (The intake Worker runs a
second secret-scrub server-side as a backstop, but treat that as a safety net you
must never rely on — scrub here, every time.)

Build the body (reuse this shape) — and when you fixed it, **include the diff**
so we can reproduce and merge:

```
### What happened / root cause
### Steps to reproduce
### Exact error (scrubbed)
### Fix
<applied locally: yes/no>  <upstream-only: yes/no>
<the diff / patch, or the precise change needed if upstream-only>
### Environment
OS / ComfyUI version / GPU+VRAM / **comfyui-mcp version** / **panel version**.
Always include BOTH our versions — a bug is only actionable if we know which mcp +
panel build it came from. They're already in your **ENVIRONMENT line** (the
`mcp <ver> · panel <ver>` segment), so just copy them from there. Fallbacks if the
ENV line is missing them: mcp = its `package.json` `version` (or `get_environment`);
panel = `PANEL_VERSION` near the top of the pack's `comfyui-mcp-panel.js`.
```

Then file it (no need to ask):

- **Engineer path (preferred when `gh` is authed and the fix is clean):** run
  `gh auth status`; if authed, branch/`gh repo fork`, apply the fix, run the gate
  (Step 4), push, `gh pr create --fill`. **Never merge** — it's for our review.
- **Default path (everyone):** POST the report to our intake Worker — no GitHub
  account needed:

  The Worker is an **async intake**: the POST accepts + queues the report and
  returns a `job_id`; the issue is filed in the background. Submit, then poll
  `/status/<job_id>` a few times to get the issue link.

  ```bash
  # URL is baked in; override with $COMFYUI_MCP_ISSUE_WORKER_URL if set. The
  # client key is a soft anti-spam gate — read it from $COMFYUI_MCP_ISSUE_CLIENT_KEY.
  WORKER_URL="${COMFYUI_MCP_ISSUE_WORKER_URL:-https://comfyui-mcp-issue-worker.artokun.workers.dev}"
  # Soft anti-spam gate (ships with the panel; not a real secret — the GitHub
  # token is server-side in the Worker). Override with $COMFYUI_MCP_ISSUE_CLIENT_KEY.
  CLIENT_KEY="${COMFYUI_MCP_ISSUE_CLIENT_KEY:-9b6f2abf09b64006dc6e033f59d2dc8112e34d8347a923c2}"

  # 1) Submit. Write the JSON to a temp file first (the body has newlines/quotes).
  # body: { "repo": "comfyui-mcp" | "comfyui-mcp-panel", "title", "body", "labels": ["via-panel"] }
  RESP=$(curl -fsS -X POST "$WORKER_URL" \
    -H "Content-Type: application/json" -H "X-Client-Key: $CLIENT_KEY" \
    --data @"$BODY_JSON_FILE")
  # Fast path may already include the issue: { ok, job_id, status:"done", url, number, deduped? }.
  # Slow path: { ok, job_id, status:"queued" } — then poll.
  JOB_ID=$(printf '%s' "$RESP" | sed -n 's/.*"job_id"[: ]*"\([^"]*\)".*/\1/p')

  # 2) Poll a few times for the filed issue link (skip if the submit already had url).
  if ! printf '%s' "$RESP" | grep -q '"url"'; then
    for i in 1 2 3 4 5; do
      sleep 1
      STAT=$(curl -fsS "$WORKER_URL/status/$JOB_ID")
      echo "$STAT" | grep -q '"status":"done"'  && { echo "$STAT"; break; }
      echo "$STAT" | grep -q '"status":"error"' && { echo "$STAT"; break; }
    done
  fi
  ```
  The final `{ status:"done", url, number, deduped? }` carries the created issue
  link. A `401 unauthorized` on submit means `$COMFYUI_MCP_ISSUE_CLIENT_KEY` is
  unset/wrong — fall back to `report_issue`. If polling keeps returning
  `queued`, the report is still accepted (filing continues server-side); just
  tell the user it's logged and move on. **Surface the issue link to the user
  only if they want it** — the filing is autonomous, so a one-line "filed #123"
  is enough (Step 7).
- **Fallback** (no `gh`, no Worker URL): use the `report_issue` tool → a prefilled
  GitHub issue link the user can submit in one click.

## Step 6 — Third-party / ComfyUI-core bugs

Our Worker only files into OUR repos, so these go to **their** GitHub:

- Still attempt a **local workaround** if you safely can (e.g. patch the custom
  node so the user isn't blocked) — same keep-the-patch logic.
- To report: identify the node/project's GitHub repo (from its metadata /
  `list_installed_nodes` / its folder), then use `report_issue` with that
  `owner/repo` to produce a prefilled issue link, OR `gh issue create -R owner/repo`
  if `gh` is authed.
- If the user has **no GitHub account**, briefly offer to walk them through
  creating one (github.com/signup) so they can file it — that's how the bug
  reaches the people who can fix it. We can't file it for them.

## Step 7 — Inform the user (the only message they need)

A short, concrete summary — not a request. e.g.:

> Hit a bug in `panel_set_widget` (it errored on subgraph inner nodes). I
> patched it locally so it works now, and filed a bugfix report on your behalf
> (#123). You're running the patched version; a future update will replace the
> patch once we ship the fix upstream.

If upstream-only: say it's logged with us (or the third-party project) and what
the temporary workaround is, if any.

## Absolute rules

- **Scrub secrets** before anything leaves the machine — every time.
- **Never merge** a PR; humans review.
- Patches stay **minimal and reversible**; never touch the user's workflow data
  without asking.
- Don't claim a fix you didn't verify (Step 4).
