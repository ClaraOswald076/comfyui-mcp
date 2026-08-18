# Writing blog posts (and not breaking the docs build)

House rules for `docs/blog/*.mdx`, and the Mintlify caveats that bite.

Everything here was **measured on this repo**, not taken from Mintlify's docs. Where something
is a hypothesis rather than a measurement, it says so. That distinction matters: half of what
"everyone knows" about this build turned out to be wrong when checked (see
[What is *not* true](#what-is-not-true)).

The audit that produced this found **28 real errors across 34 posts** — including a licence
that would have cost a reader money, and one sentence that was false in ten posts at once.
The gates exist so those specific failures cannot recur silently.

---

## 1. Run the gates before you push

```bash
npm test           # runs the six below
```

| command | enforces | in `npm test`? |
|---|---|---|
| `npm run check:blog` | the shared install step matches `docs/snippets/panel-install.mdx`; no retired claims | yes |
| `npm run check:blog-packs` | every model/script filename you name is one the pack actually ships | yes |
| `npm run check:blog-structure` | every model post has a non-empty `## Licensing` section | yes |
| `npm run check:blog-stale` | a post's `verified:` stamp is newer than the packs it documents | yes |
| `npm run check:docs-links` | nav ↔ files ↔ links all resolve | yes |
| `npm run check:docs-locale` | translated pages match their English source structurally | yes |
| `npm run check:docs-mdx` | no unescaped lowercase JSX tags (`<pod>`) in prose | yes |
| `node scripts/asset-counts.mjs --check` | advertised counts match the live registry | **no — CI only** |
| `node scripts/check-docs-deployed.mjs` | every nav page actually serves | **no — after deploy** |

The last two are the ones to remember, because `npm test` passing does **not** mean they did:

- **`asset-counts --check` runs in CI** (`.github/workflows/ci.yml` and `release.yml`), not in
  `npm test` — it needs a fresh `dist/` to read the live tool registry. Run it yourself after
  `npm run build` if you touched a count.
- **`check-docs-deployed.mjs` runs nowhere automatically.** It needs the network and a
  published site, and a gate that fails on flaky wifi gets ignored. Run it after a deploy:

  ```bash
  node scripts/check-docs-deployed.mjs          # every nav page actually serves
  node scripts/check-docs-deployed.mjs ko ja    # or specific locales
  ```

  It exists because a page can be correct in git, correct in navigation, pass every static
  check, and still not exist for a reader. Two currently do exactly that.

---

## 2. Structure

The model posts already share a spine, and it emerged without a gate, so most of it is
convention rather than enforcement:

`What is it` → `vs. alternatives` → **`Licensing`** → `System & VRAM` → `Install` →
`Settings that matter` → `Troubleshooting` → `FAQ` → `Get it running in one command`

**`## Licensing` is the one required section** (`check:blog-structure`). It is required
because it was the *least* consistent thing across the posts — 1 of 11 had it as a heading, 8
buried it in prose, 2 had no licensing content at all — while being the highest-stakes fact on
the page. Both money-costing errors in the audit lived there.

Put it before the VRAM section. Name the licence exactly, and say what gates commercial use —
**revenue, not seats**. `krea2` invented a "50 seats" allowance for a licence whose actual gate
is $1,000,000 in company-wide revenue.

> **Read the licence off the model card.** Not from another post, not from memory. `ltx-2.3`
> called the LTX-2 Community License "Apache 2.0" three times. In the same audit, ERNIE's
> Apache-2.0 claim was checked the same way and was *correct* — so don't pattern-match after
> finding one bad one either way.

### Titles and slugs

- **No year markers.** "(2026 Guide)" reads stale from January. Ten titles were cleaned.
- **Never rename a slug.** `wan-2.2-comfyui` keeps its version because a model version stays
  true, and a rename burns inbound links and accumulated ranking for no accuracy gain.

---

## 3. Claims that are checked mechanically

### Model and script filenames

Any `*.gguf` / `*.safetensors` / `*.pth` you name **in a table row or a fenced block** must
exist in a pack the post documents. Prose is exempt — that is where legitimate alternatives
live:

```md
Swap the four `Wan2.2-*-Q8_0.gguf` files for the `-Q4_K_S` builds.   <!-- fine, prose -->
```

A `.bat` / `.sh` / `.ps1` **in a fence** must exist in the pack, unless the line contains a URL
(`curl … | sh` downloads it) or the script sits under a non-pack directory.

Two posts told readers to run `WAN2_2-ULTRA-MODELS-NODES_INSTALL.bat`. It has never existed;
the packs ship `install-windows.bat` / `install-runpod.sh`.

### Counts

Any "N tools / N skills / N packs" claim must match `scripts/asset-counts.mjs`. Add a row
there when you write a new one — and use `\s+` between words, not literal spaces, or a routine
re-wrap of the paragraph will break it.

`local-llms-comfyui` said "roughly 200 tools" in three places. The real number is 37.

### The shared install step

If your post carries the standard "install and connect" step, it must match
`docs/snippets/panel-install.mdx` **exactly**, and your filename must be listed in
`EXPECTED_CARRIERS` in `scripts/check-blog-boilerplate.mjs`.

The registry exists because the marker text both selects and validates: edit the marker and
the post silently leaves coverage. A count was tried first and mutation-testing killed it — a
*swap* (one post leaves, another joins) keeps the count identical.

If your post's install step is genuinely different (`train-lora-runpod` sets `RUNPOD_API_KEY`;
`video-extend-pusa` applies a specific pack), just don't use the canonical sentence.

### Staleness

Add `verified: YYYY-MM-DD` to frontmatter the day you last read the post **against source**,
and add the filename to `STAMPED` in `scripts/check-blog-staleness.mjs`.

A stamped post fails the build once a pack it documents changes after that date. Unstamped
posts are reported but do not block — bulk-stamping to get green manufactures exactly the false
assurance the stamp exists to prevent.

---

## 4. What breaks a Mintlify page

### Links

Both `/docs/backends` and `/backends` render the real page. **Doubling the prefix does not:**

| URL | result |
|---|---|
| `/docs/backends` | renders |
| `/backends` | renders |
| `/docs/docs/backends` | **404** — same shell as a nonsense URL |

In **localized** pages, always use the absolute `/docs/…` form. A relative `./concepts` from
`ko/installation` resolves to `/ko/concepts`, which does not exist. The single form is pinned
(`check:docs-locale`) not because the other is broken, but because when the two drift apart,
review agents rewrite each other's files in opposite directions — both "fixes" look correct
from inside a single file.

### Anchors

Cross-page anchors are checked against the target page's headings after translation. Non-ASCII
anchors are **fine** — `#3-패널-오케스트레이터-시작하기` resolves correctly.

Slugs keep Unicode combining marks. The Arabic shadda in `منسّق` (U+0651) is part of the word;
a slugifier that strips `\p{M}` reports a correct anchor as broken and pushes a translator to
mangle correct Arabic.

### Comments

`.mdx` has two comment forms and **both hide content**: `<!-- … -->` and `{/* … */}`. A
commented-out heading is not a section.

### Components inside lists

A block-level component (`<Note>`, `<Card>`) inside a numbered list item renders differently
than it reads. This is why the shared install step is still copied text rather than an imported
snippet — converting ten live posts to it without a local `mint dev` render check is a bet on
the docs site.

### Unescaped `<placeholder>` is JSX — it 404s the page

MDX treats `<pod>` as a component named `pod`. A page that contains it
**outside a code span** does not build; Mintlify serves the 404 shell and
the rest of the site still deploys. That is why every locale `panel` page
and `changelog/2026-07-21` 404'd while their siblings (and the older
English `panel`, which had not yet gained the RunPod sentence) served.

Size was the wrong hypothesis: `zh/panel` is only ~1 KB larger than
English and 404'd for the same `<pod>`. Write placeholders as `` `<pod>` ``
or drop the angle brackets. `check:docs-mdx` rejects a lowercase HTML/JSX
tag in prose.

---

## 5. Localization

`docs/<locale>/` mirrors five entry pages. When adding or regenerating one:

**Mintlify language codes are a closed enum.** `navigation.languages[].language` must be a
code their schema accepts (`https://www.mintlify.com/docs.json`). An unknown code fails the
**entire** production build and leaves the previous deploy up — that is how the site froze
on the Korean pilot after Persian (`fa`) was added. `fa` is a real BCP-47 tag and a real
panel locale; it is not a Mintlify language. Keep `docs/fa/*.mdx` in git; do not put `fa`
back in the switcher until their schema lists it. `check:docs-links` now rejects an
unsupported code.

**Never translate:** fenced code (including comments inside it), inline backticks (flags, env
vars, paths, tool names, `action` values, JSON keys), MDX component names and props, URLs, the
target half of a link, `icon:` tokens, or frontmatter *keys*.

**Always translate** the frontmatter `title` and `description` — they are the SERP snippet, and
they are the most commonly skipped item.

Reuse the panel's settled vocabulary from `comfyui-mcp-panel/locales/<code>/main.json`. Docs
disagreeing with the UI the reader is looking at is worse than either choice alone.

### One-locale wave (after ko/ja)

Korean and Japanese are the template: every **guide** page, not tools/blog/changelog.

1. Copy the 16 remaining English guides into `docs/<lang>/` (or the ones that locale still lacks).
2. Translate under the hard rules above. Do **one language per PR**.
3. Expand that language in `docs.json` to the same two groups as English (Getting Started + Configuration). Never add `fa` to the switcher.
4. Stop only when all three pass: `check:docs-locale <lang>`, `check:docs-links`, `check:docs-mdx`.
5. `npm run check:vocabulary` — the `using-tools` old-name → new-form table must keep **English cells** (identifiers). Add `allowedIn` rows in `src/tools/vocabulary.ts` for `docs/<lang>/using-tools.mdx` with the same context strings as `docs/using-tools.mdx`. Do not invent a glob.
6. After merge, `node scripts/check-docs-deployed.mjs <lang>`. A nav page that 404s stops the next wave.

Do not `/loop` the rest. The finish line is the gates plus a live URL, not "I wrote the files."

---

## What is *not* true

Things stated confidently in this repo's history that turned out to be wrong when checked.
They are here because each cost real time:

- **"Mintlify returns 200 for unknown paths, so the HTTP status is useless."** False. It
  returns **404** for missing pages and 200 for real ones. That claim was generalized from
  three URLs that all happened to be real pages, with no known-bad URL ever probed.
- **"The `Mintlify Deployment` check tells you whether the site deployed."** It does not. It
  reports `skipped — No eligible deployments found for changes` on commits that **did** deploy.
- **"The `/docs/` prefix in the Korean pilot was invented and 404s."** It renders fine. An
  agent rewrote 22 link targets on that belief before it was measured.

The pattern: every one was reasoned from repo conventions rather than observed. When a
question is about *routing or rendering*, only the deployed URL can answer it.
