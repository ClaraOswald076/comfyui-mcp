#!/usr/bin/env node
/**
 * Regenerates src/services/manager-bare-name-collisions.ts — the snapshot of custom-node
 * pack names that ComfyUI-Manager v4 resolves to DIFFERENT repositories depending on
 * which channel is asked (artokun/comfyui-mcp#1616).
 *
 * Run manually (it fetches the six published channel lists); it is not part of the build
 * or the test suite. A stale snapshot fails safe — see the guard's own comment.
 *
 *   node scripts/gen-manager-name-collisions.mjs
 *
 * WHY THESE KEYS. Read off ComfyUI-Manager 4.2.2's own source
 * (comfyui_manager/glob/manager_core.py):
 *
 *   load_nightly(channel, mode)
 *     json_obj = get_data_by_mode(mode, 'custom-node-list.json', channel_url)
 *     for y in x['files']: if 'github.com' in y and not y.endswith(('.py','.js')):
 *         res[y.split('/')[-1]] = (x, False)          # keyed by the BARE REPO NAME
 *   get_custom_nodes(channel, mode) -> NormalizedKeyDict          # get() lowercases
 *     len(files) == 1 -> key = files[0].split('/')[-1], repository = files[0]
 *     len(files)  > 1 -> key = files[0]               # a whole URL; unreachable by name
 *   install_by_id(node_id, 'nightly', channel, mode)
 *     the_node = custom_nodes.get(node_id); repo_url = the_node['repository']
 *
 * So the URL that gets CLONED comes from the channel's list entry, never from the
 * `repository` the caller passed — which v4 stores in the task params and never reads on
 * this path.
 */
import { writeFileSync } from "node:fs";

const BASE = "https://raw.githubusercontent.com/Comfy-Org/ComfyUI-Manager/main";
// comfyui_manager/channels.list.template @ 4.2.2 — the names normalize_channel accepts.
const CHANNEL_URLS = {
  default: BASE,
  recent: `${BASE}/node_db/new`,
  legacy: `${BASE}/node_db/legacy`,
  forked: `${BASE}/node_db/forked`,
  dev: `${BASE}/node_db/dev`,
  tutorial: `${BASE}/node_db/tutorial`,
};
const CHANNELS = Object.keys(CHANNEL_URLS);

/** Manager's git_utils.normalize_url, reduced to the owner/repo it keeps. */
function ownerRepo(url) {
  const s = String(url).trim().replace(/\/+$/, "");
  if (!s.includes("github")) return null;
  const noGit = s.endsWith(".git") ? s.slice(0, -4) : s;
  const parts = noGit.split("/");
  const repo = parts[parts.length - 1];
  let owner = parts[parts.length - 2] ?? "";
  if (owner.startsWith("git@github.com:")) owner = owner.split(":")[1];
  if (!owner || !repo) return null;
  return `${owner}/${repo}`;
}

/**
 * lower(bare name) -> Set(owner/repo) that this channel's list carries under it.
 *
 * EVERY repository under the name, not the one that would win. Manager drops all but one:
 * `load_nightly`'s `res[repo_name] = (x, False)` overwrites on an exact-case duplicate, and
 * `NormalizedKeyDict.__setitem__` re-points `_key_map` on a case-variant one. So exactly
 * one entry is reachable and WHICH one is decided by the order of an upstream JSON file.
 *
 * Modelling that order and letting the winner through was this generator's first shape,
 * and it is wrong twice over: it hides the loser completely — an exact-case duplicate then
 * looks like a unique name and the guard never fires for it — and an upstream reorder
 * silently flips a call from correct to wrong-repo with nothing here changing. Recording
 * every candidate is order-independent and refuses both spellings, which is the standing
 * rule: name the candidates, never pick between them.
 */
async function channelEntries(channel) {
  const res = await fetch(`${CHANNEL_URLS[channel]}/custom-node-list.json`);
  if (!res.ok) throw new Error(`${channel}: HTTP ${res.status}`);
  const raw = await res.json();
  const out = [];
  for (const x of raw.custom_nodes) {
    const files = x.files ?? [];
    // len(files) > 1 is keyed by files[0] — a whole URL, unreachable by a bare name.
    if (files.length !== 1) continue;
    const url = files[0];
    // load_nightly reaches an entry through a github file or through its `id`;
    // get_custom_nodes then keys it by the file's basename either way.
    const viaFile = url.includes("github.com") && !url.endsWith(".py") && !url.endsWith(".js");
    if (!viaFile && x.id === undefined) continue;
    const repo = ownerRepo(url);
    if (!repo) continue;
    out.push({ repo, bare: url.split("/").pop().trim() });
  }
  return out;
}

/** lower(bare name) -> Set(owner/repo), the shape AMBIGUOUS_BARE_NAMES is built from. */
function channelMap(entries) {
  const out = new Map();
  for (const { repo, bare } of entries) {
    const key = bare.toLowerCase();
    if (!out.has(key)) out.set(key, new Set());
    out.get(key).add(repo);
  }
  return out;
}

const entries = {};
const maps = {};
for (const c of CHANNELS) {
  entries[c] = await channelEntries(c);
  maps[c] = channelMap(entries[c]);
  process.stderr.write(`${c}: ${maps[c].size} bare-name keys\n`);
}

const byName = new Map();
for (const c of CHANNELS) {
  for (const [name, repos] of maps[c]) {
    if (!byName.has(name)) byName.set(name, {});
    byName.get(name)[c] = [...repos].sort();
  }
}

// A name is AMBIGUOUS when the repositories seen under it — across channels, or twice
// within one channel via a case variant — are not all the same repository.
const ambiguous = [...byName.entries()]
  .filter(([, per]) => new Set(Object.values(per).flat().map((r) => r.toLowerCase())).size > 1)
  .sort((a, b) => a[0].localeCompare(b[0]));

const intra = ambiguous.filter(([, per]) => Object.values(per).some((r) => r.length > 1)).length;
process.stderr.write(`\nambiguous bare names: ${ambiguous.length} (${intra} ambiguous inside a single channel)\n`);

/**
 * THE COMFY REGISTRY, because a channel entry is not always reachable by the bare name.
 *
 * `get_custom_nodes` keys an entry by its CNR id whenever the repo is registered, and only
 * falls back to the file's basename when it is not:
 *
 *   cnr = self.get_cnr_by_repo(v['files'][0])
 *   if cnr: v['id'] = cnr['id']; node_id = v['id']
 *   else:   node_id = v['files'][0].split('/')[-1]
 *   res[node_id] = v
 *
 * So a repo registered under an id OTHER than its own name disappears from the bare-name
 * keyspace, `install_by_id` misses, and the nightly path falls back to `cnr_map[name]` —
 * a DIFFERENT publisher's pack. Without this table the guard exempts exactly that case,
 * because the channel does list the caller's repo; it just cannot be reached by name.
 *
 * `repo_cnr_map` is a plain dict keyed by `git_utils.normalize_url` — which for a github
 * URL is `https://github.com/{author}/{repo}` with case PRESERVED — so the match is
 * case-sensitive and is done that way here. `cnr_map`, by contrast, is a NormalizedKeyDict
 * whose `get` lowercases, which is why the id side is folded.
 */
async function registryMaps() {
  const repoToId = new Map(); // "Owner/Repo" (case-sensitive) -> cnr id
  const idToRepo = new Map(); // lowercased cnr id -> "Owner/Repo"
  let page = 1;
  let totalPages = 1;
  do {
    const res = await fetch(`https://api.comfy.org/nodes?page=${page}&limit=100`);
    if (!res.ok) throw new Error(`registry page ${page}: HTTP ${res.status}`);
    const j = await res.json();
    totalPages = j.totalPages ?? 1;
    for (const n of j.nodes ?? []) {
      if (!n.id) continue;
      const repo = n.repository ? ownerRepo(n.repository) : null;
      if (repo) {
        repoToId.set(repo, String(n.id));
        idToRepo.set(String(n.id).trim().toLowerCase(), repo);
      }
    }
    if (page % 10 === 0 || page === totalPages) {
      process.stderr.write(`  registry page ${page}/${totalPages}\n`);
    }
    page++;
  } while (page <= totalPages);
  return { repoToId, idToRepo };
}

process.stderr.write(`\nfetching the Comfy Registry (for CNR re-keying)…\n`);
const { repoToId, idToRepo } = await registryMaps();
process.stderr.write(`registry: ${repoToId.size} repositories, ${idToRepo.size} ids\n`);

// A candidate is UNREACHABLE by the bare name when it is registered under a different id.
const rekeyed = {};
const registryTargets = {};
for (const [name, per] of ambiguous) {
  const lost = [];
  for (const repos of Object.values(per)) {
    for (const r of repos) {
      const id = repoToId.get(r);
      if (id !== undefined && id.trim().toLowerCase() !== name) lost.push(r);
    }
  }
  if (lost.length) rekeyed[name] = [...new Set(lost)].sort();
  const target = idToRepo.get(name);
  if (target) registryTargets[name] = target;
}
process.stderr.write(
  `re-keyed candidates: ${Object.values(rekeyed).flat().length} across ${Object.keys(rekeyed).length} names; ` +
    `${Object.keys(registryTargets).length} names have a registry pack of their own name\n`,
);

/**
 * #1624 — THE SAME SUBSTITUTION WITHOUT ANY CHANNEL COLLISION.
 *
 * The table above is keyed by CONTESTED bare names, which is a narrower thing than the
 * hazard. Re-keying needs no second channel to hand back another author's repository: it
 * is enough that the repo a caller names is registered under an id that is not its own
 * name (so `get_custom_nodes` files it under THAT id and a bare-name lookup can never
 * return it) and that something else answers to the name. Measured, that is 56 live
 * repositories the contested-name table does not cover at all.
 *
 * So simulate the real lookup instead of approximating it. For every repository a caller
 * could plausibly name — everything in the six channel lists plus everything in the
 * registry — replay 4.2.2's own resolution:
 *
 *   get_custom_nodes: key = get_cnr_by_repo(files[0]) ? cnr['id'] : files[0].basename
 *                     (repo_cnr_map is a PLAIN dict on a case-preserving normalize_url,
 *                      so that match is case-SENSITIVE and is done that way here)
 *   install_by_id:    the_node = custom_nodes.get(bare)        # NormalizedKeyDict, lower
 *                     miss + nightly -> cnr_map.get(bare)      # the registry's repo
 *
 * and record only the repositories for which that lands somewhere ELSE. A repo that is
 * re-keyed but whose name resolves to nothing at all (1271 of them) is NOT recorded:
 * Manager answers "not found" there, which installs nobody's code and is a different bug.
 */
const REKEY_CHANNELS = CHANNELS;
const bareOf = (repo) => repo.split("/")[1];
const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();

// channel -> Map(lower(node_id Manager files it under) -> Set(owner/repo))
const keyedByManager = {};
for (const c of REKEY_CHANNELS) {
  const m = new Map();
  for (const { repo, bare } of entries[c]) {
    const id = repoToId.get(repo); // case-sensitive, mirrors repo_cnr_map
    const key = (id !== undefined ? id : bare).trim().toLowerCase();
    if (!m.has(key)) m.set(key, new Set());
    m.get(key).add(repo);
  }
  keyedByManager[c] = m;
}

const nameable = new Set();
for (const c of REKEY_CHANNELS) for (const e of entries[c]) nameable.add(e.repo);
for (const r of repoToId.keys()) nameable.add(r);

const substitutions = [];
let unreachableButHarmless = 0;
for (const repo of [...nameable].sort()) {
  const nameKey = bareOf(repo).trim().toLowerCase();
  const id = repoToId.get(repo);
  // Not registered, or registered under its own name: a bare-name lookup CAN return it.
  if (id === undefined || id.trim().toLowerCase() === nameKey) continue;
  const channelTargets = {};
  for (const c of REKEY_CHANNELS) {
    // By construction none of these can be `repo` itself — it is filed under `id`, not
    // under its name — but filter anyway rather than trust the construction, because a
    // record naming the caller's own repository as the substitute would be nonsense.
    const hit = [...(keyedByManager[c].get(nameKey) ?? [])].filter((r) => !sameRepo(r, repo)).sort();
    if (hit.length) channelTargets[c] = hit;
  }
  const target = idToRepo.get(nameKey);
  const registryTarget = target && !sameRepo(target, repo) ? target : undefined;
  if (!Object.keys(channelTargets).length && !registryTarget) {
    unreachableButHarmless++; // resolves to nothing -> Manager's "not found", not a swap
    continue;
  }
  substitutions.push({ repo, id, channelTargets, registryTarget });
}

// The lookup key is lowercased, so two DIFFERENT repositories differing only in case
// would collapse onto one record and the guard would answer about the wrong one. Nothing
// in the guard could detect that, so it is caught HERE, where the fix is to change the
// key rather than to ship a table that quietly answers wrong.
{
  const seen = new Map();
  for (const s of substitutions) {
    const k = s.repo.toLowerCase();
    if (seen.has(k)) throw new Error(`case-collision on ${k}: ${seen.get(k)} vs ${s.repo}`);
    seen.set(k, s.repo);
  }
}
const onDefault = substitutions.filter(
  (s) => (s.channelTargets.default ?? []).length > 0 || s.registryTarget !== undefined,
).length;
process.stderr.write(
  `\nre-keyed repositories whose own name resolves to someone ELSE: ${substitutions.length} ` +
    `(${onDefault} of them on the "default" channel); ` +
    `${unreachableButHarmless} more are re-keyed but resolve to nothing (Manager answers "not found")\n`,
);

const measured = new Date().toISOString().slice(0, 10);
const body = ambiguous
  .map(([name, per]) => {
    const inner = CHANNELS.filter((c) => per[c])
      .map((c) => `${c}: [${per[c].map((r) => JSON.stringify(r)).join(", ")}]`)
      .join(", ");
    return `  ${JSON.stringify(name)}: { ${inner} },`;
  })
  .join("\n");

const out = `// GENERATED by scripts/gen-manager-name-collisions.mjs — do not edit by hand.
// Measured ${measured} against the six published ComfyUI-Manager channel lists.
//
// The channel names ComfyUI-Manager's \`normalize_channel\` accepts, from its own
// channels.list.template. A channel this table has never heard of is not checked.
export const MANAGER_CHANNEL_NAMES = [${CHANNELS.map((c) => JSON.stringify(c)).join(", ")}] as const;
export type ManagerChannelName = (typeof MANAGER_CHANNEL_NAMES)[number];

//
// Each key is a custom-node pack's BARE REPO NAME, lowercased: the string
// ComfyUI-Manager v4 actually resolves a from-source ("nightly") install by, and the
// string the panel derives from a caller's git URL and sends as \`id\`. Each value maps a
// channel to the repositories THAT channel's custom-node-list.json carries under that
// name. An array of length > 1 means the one channel is ambiguous by itself — two entries
// differing only in case, which collapse in Manager's NormalizedKeyDict (its \`get\` keys
// on \`key.strip().lower()\`), where the winner is list order.
//
// Only ambiguous names are listed: ${ambiguous.length} of them, ${intra} ambiguous within a single channel.
// A name absent from this table is not known to collide, which is not the same as proven
// unique — see \`bareNameAmbiguity\` for what that costs.
export const AMBIGUOUS_BARE_NAMES: Readonly<
  Record<string, Readonly<Partial<Record<ManagerChannelName, readonly string[]>>>>
> = {
${body}
};

//
// Candidates above that a BARE-NAME lookup cannot reach, because ComfyUI-Manager keys a
// channel entry by its Comfy Registry id when the repo is registered (get_custom_nodes:
// \`if cnr: node_id = v['id']\`). A name whose only listed repo is in here resolves through
// the registry instead of through the channel, so "the channel lists exactly your repo" is
// NOT on its own a reason to let the install through.
export const REKEYED_REPOS: Readonly<Record<string, readonly string[]>> = {
${Object.entries(rekeyed)
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([n, repos]) => `  ${JSON.stringify(n)}: [${repos.map((r) => JSON.stringify(r)).join(", ")}],`)
  .join("\n")}
};

//
// What \`cnr_map[<bare name>]\` resolves to — the repository Manager clones when the channel
// lookup misses and the registry holds that id (install_by_id's nightly fallback). This is
// the repo a caller actually gets in that case, so the refusal can name it outright.
export const REGISTRY_TARGETS: Readonly<Record<string, string>> = {
${Object.entries(registryTargets)
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([n, repo]) => `  ${JSON.stringify(n)}: ${JSON.stringify(repo)},`)
  .join("\n")}
};

//
// #1624 — REPOSITORIES THAT CANNOT BE INSTALLED BY THEIR OWN NAME, AND WHO ANSWERS INSTEAD.
//
// Keyed by the caller's \`owner/repo\`, LOWERCASED: the question this answers is "did the
// caller name one of these", and a caller types whatever case they like. (The generator
// throws if two distinct repositories ever collapse onto one such key.)
//
// Every repository here is registered in the Comfy Registry under an id that is not its
// own bare name, so \`get_custom_nodes\` files it under that id and a bare-name lookup
// CANNOT return it — from any channel, whatever the channel's list appears to say. What a
// lookup returns instead is recorded: \`channelTargets\` per channel, and \`registryTarget\`
// for the nightly fallback that fires when the channel carries nothing under the name.
//
// Recorded ONLY where something else actually answers. A re-keyed repository whose name
// resolves nowhere gets Manager's "not found", which installs nobody's code, and is left
// out rather than turned into a refusal.
export interface RekeyedSubstitution {
  /** The repository, cased as the Comfy Registry records it. */
  readonly repo: string;
  /** The Comfy Registry id it is filed under — the reason its own name misses. */
  readonly id: string;
  /** Per channel, what a bare-name lookup DOES reach under that name. */
  readonly channelTargets: Readonly<Partial<Record<ManagerChannelName, readonly string[]>>>;
  /** What \`cnr_map[<bare name>]\` clones when the channel carries nothing under it. */
  readonly registryTarget?: string;
}
export const REKEYED_SUBSTITUTIONS: Readonly<Record<string, RekeyedSubstitution>> = {
${substitutions
  .map((s) => {
    const chans = REKEY_CHANNELS.filter((c) => s.channelTargets[c])
      .map((c) => `${c}: [${s.channelTargets[c].map((r) => JSON.stringify(r)).join(", ")}]`)
      .join(", ");
    const reg = s.registryTarget ? `, registryTarget: ${JSON.stringify(s.registryTarget)}` : "";
    return `  ${JSON.stringify(s.repo.toLowerCase())}: { repo: ${JSON.stringify(s.repo)}, id: ${JSON.stringify(s.id)}, channelTargets: { ${chans} }${reg} },`;
  })
  .join("\n")}
};

/** When AMBIGUOUS_BARE_NAMES was measured, for the refusal to cite. */
export const AMBIGUOUS_BARE_NAMES_MEASURED = ${JSON.stringify(measured)};
`;

writeFileSync(new URL("../src/services/manager-bare-name-data.ts", import.meta.url), out);
process.stderr.write(`wrote src/services/manager-bare-name-data.ts (${out.length} bytes)\n`);
