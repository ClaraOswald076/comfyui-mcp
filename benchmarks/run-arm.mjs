/**
 * Run one BLIND arm of the tool-reach benchmark.
 *
 *   node benchmarks/run-arm.mjs --base http://127.0.0.1:11434/v1 --model qwen3:4b
 *   node benchmarks/run-arm.mjs --base https://api.moonshot.ai/v1 --model kimi-k2 --key $KIMI_KEY
 *
 * Any OpenAI-compatible /chat/completions endpoint works, which covers Ollama and the
 * hosted providers without a second code path.
 *
 * BLIND BY CONSTRUCTION. The model is shown the 37 tool names and descriptions and the
 * request — never `expect`, never `alt`, never `why`. That is the whole reason the
 * corpus is worth running against someone else: the author's own arm cannot be blind.
 *
 * COSTS REAL RESOURCES. 100 requests against a hosted model is 100 billable calls, and
 * a local model resident on a single-GPU box competes with ComfyUI for VRAM. Neither is
 * started or paid for implicitly — you point this at an endpoint deliberately.
 *
 * Scoring is deliberately three-way, not pass/fail:
 *   hit       — matched `expect`
 *   alt       — matched a listed alternative; the SURFACE is ambiguous here, not the
 *               model. Counting these as misses would blame the model for the
 *               benchmark's own design.
 *   miss      — something else, or an unparseable answer
 * An unparseable answer is reported separately from a wrong tool, because "could not
 * follow the format" and "picked the wrong tool" call for different fixes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const base = arg("base");
const model = arg("model");
const key = arg("key", process.env.OPENAI_API_KEY ?? "");
const limit = Number(arg("limit", "100"));
if (!base || !model) {
  console.error("usage: run-arm.mjs --base <openai-compatible-url> --model <name> [--key K] [--limit N]");
  process.exit(2);
}

const rows = readFileSync(join(here, "tool-reach.jsonl"), "utf8")
  .trim().split(/\r?\n/).map((l) => JSON.parse(l)).slice(0, limit);

// The tool surface, read from the shipped vocabulary so an arm can never be run against
// a stale list. Descriptions come from the built tool defs when available; names alone
// are still a valid (harder) arm, and which one you ran is recorded in the output.
const vocabSrc = readFileSync(join(here, "..", "src", "tools", "vocabulary.ts"), "utf8");
const names = [...vocabSrc.match(/export const TOOL_NAMES = \[[\s\S]*?\n\] as const/)[0]
  .matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]);

const system =
  `You route a user's request to exactly ONE tool. Reply with the tool name only — ` +
  `no punctuation, no explanation. Available tools:\n${names.join("\n")}`;

async function ask(request) {
  const res = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [{ role: "system", content: system }, { role: "user", content: request }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j = await res.json();
  return String(j?.choices?.[0]?.message?.content ?? "").trim().split(/\s+/)[0].replace(/[^a-z0-9_]/gi, "");
}

const tally = { hit: 0, alt: 0, miss: 0, unparseable: 0 };
const misses = [];
for (const row of rows) {
  let answer;
  try {
    answer = await ask(row.request);
  } catch (err) {
    tally.unparseable++;
    misses.push({ id: row.id, request: row.request, expect: row.expect, got: `ERROR ${err.message}` });
    continue;
  }
  if (!names.includes(answer)) {
    tally.unparseable++;
    misses.push({ id: row.id, request: row.request, expect: row.expect, got: answer || "(empty)" });
  } else if (answer === row.expect) tally.hit++;
  else if ((row.alt ?? []).includes(answer)) tally.alt++;
  else {
    tally.miss++;
    misses.push({ id: row.id, request: row.request, expect: row.expect, got: answer });
  }
}

const n = rows.length;
console.log(JSON.stringify({
  model, base, surface: `${names.length} tools`, promptedWith: "names only",
  n, ...tally,
  hitRate: +(tally.hit / n).toFixed(3),
  hitOrAltRate: +((tally.hit + tally.alt) / n).toFixed(3),
}, null, 2));
if (misses.length) {
  console.log("\nMISSES (the useful part — read these, not the score):");
  for (const m of misses) console.log(`  #${m.id} "${m.request}"\n      expected ${m.expect}, got ${m.got}`);
}
