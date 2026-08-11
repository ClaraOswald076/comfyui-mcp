/**
 * PER-TAB panel language for the bridge's HUMAN-facing `say` frames.
 *
 * A `say` renders as a chat bubble inside ONE panel tab, and those strings name panel
 * controls ("Settings → OpenRouter → 'Set API key…'"). Rendered in the process locale — the
 * language of whoever launched the orchestrator — the instruction would point at a label the
 * user cannot find on their own screen. So the language has to come from the destination tab,
 * which is what `hello.locale` + `tabLocale()` provide.
 *
 * The behaviour actually worth guarding is what happens when it CANNOT work. These frames are
 * emitted while reporting OTHER failures — an agent that would not start, render results that
 * were lost, a panel sync that did not happen — so a locale lookup that threw would turn one
 * failure report into two. Every unknown here must produce English, never an exception.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { UiBridge } from "../../services/ui-bridge.js";
import { trFor, __resetI18nForTest } from "../../i18n/index.js";
import {
  buildStartFailureNotice,
  startFailureHint,
} from "../../orchestrator/start-failure-notice.js";

let bridge: UiBridge;
let port: number;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const p = addr && typeof addr === "object" ? addr.port : 0;
      srv.close((err) => (err ? reject(err) : resolve(p)));
    });
  });
}

/** Open a socket without registering, so a test can drive the hello frames itself. */
function open(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const sock = new WebSocket(`ws://127.0.0.1:${port}`);
    sock.on("open", () => resolve(sock));
    sock.on("error", reject);
  });
}

/** Register `tabId` on `sock`, resolving once the bridge has processed the hello. */
async function hello(
  sock: WebSocket,
  tabId: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const before = bridge.tabConnectionGeneration(tabId);
  sock.send(JSON.stringify({ type: "hello", tab_id: tabId, title: "wf", ...extra }));
  // Every hello bumps the tab's generation, so this waits for THIS hello rather than for a
  // fixed sleep — a re-hello that changes nothing observable would otherwise race.
  for (let i = 0; i < 100; i++) {
    if (bridge.tabConnectionGeneration(tabId) !== before) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`hello for ${tabId} was never processed`);
}

beforeEach(async () => {
  port = await freePort();
  bridge = new UiBridge(port);
  bridge.start();
  expect(await bridge.whenReady()).toBe(true);
});

afterEach(async () => {
  await bridge.stop();
  __resetI18nForTest();
});

describe("tabLocale — where a say frame's language comes from", () => {
  it("takes the language the panel advertised in its hello", async () => {
    const sock = await open();
    await hello(sock, "tab-ko", { locale: "ko" });
    expect(bridge.tabLocale("tab-ko")).toBe("ko");
    sock.close();
  });

  it("normalises what the panel actually sends (regional + script variants)", async () => {
    // ComfyUI's own language list is the source, so the panel can hand us pt-PT or zh-HK;
    // both must land on a locale we ship rather than silently degrading to English.
    const a = await open();
    await hello(a, "tab-pt", { locale: "pt-PT" });
    expect(bridge.tabLocale("tab-pt")).toBe("pt-BR");
    const b = await open();
    await hello(b, "tab-hk", { locale: "zh-HK" });
    expect(bridge.tabLocale("tab-hk")).toBe("zh-TW");
    a.close();
    b.close();
  });

  it("falls back to English for a tab that never advertised a language", async () => {
    // The panel builds that predate `hello.locale` are the common case, not an error.
    const sock = await open();
    await hello(sock, "tab-old");
    expect(bridge.tabLocale("tab-old")).toBe("en");
    sock.close();
  });

  it("falls back to English for a language we do not ship, rather than guessing a neighbour", async () => {
    const sock = await open();
    await hello(sock, "tab-kl", { locale: "kl-GL" });
    expect(bridge.tabLocale("tab-kl")).toBe("en");
    sock.close();
  });

  it("falls back to English for junk instead of throwing", async () => {
    // Not a security boundary — the panel is trusted — but this value is read while
    // REPORTING a failure, so a bad one must not be able to add a second failure.
    const sock = await open();
    await hello(sock, "tab-junk", { locale: { nope: true } });
    expect(bridge.tabLocale("tab-junk")).toBe("en");
    sock.close();
  });

  it("answers English for an unknown, ambiguous or disconnected tab instead of throwing", () => {
    // resolveTarget THROWS for all three. Every caller here is mid-failure-report, so the
    // lookup absorbs it: a frame in the wrong language is a blemish, an exception is a bug.
    expect(() => bridge.tabLocale("never-existed")).not.toThrow();
    expect(bridge.tabLocale("never-existed")).toBe("en");
    expect(bridge.tabLocale("")).toBe("en");
  });

  it("keeps the language across a same-socket re-hello that omits it", async () => {
    // The workflow-switch re-hello does not restate every field; the panel's language did
    // not change just because this frame was shorter.
    const sock = await open();
    await hello(sock, "tab-keep", { locale: "ja" });
    expect(bridge.tabLocale("tab-keep")).toBe("ja");
    await hello(sock, "tab-keep");
    expect(bridge.tabLocale("tab-keep")).toBe("ja");
    sock.close();
  });

  it("lets a same-socket re-hello CHANGE the language", async () => {
    const sock = await open();
    await hello(sock, "tab-switch", { locale: "ja" });
    await hello(sock, "tab-switch", { locale: "fr" });
    expect(bridge.tabLocale("tab-switch")).toBe("fr");
    sock.close();
  });

  it("resets to English when a re-hello asks for a language we do not ship", async () => {
    // PRESENCE is authoritative, not resolvability. Someone who just switched the panel to
    // German needs English here — keeping their previous Japanese would name controls in a
    // language that is no longer anywhere on their screen, which is worse than not trying.
    const sock = await open();
    await hello(sock, "tab-de", { locale: "ja" });
    await hello(sock, "tab-de", { locale: "de" });
    expect(bridge.tabLocale("tab-de")).toBe("en");
    // …and the same for a value that is not even a string.
    await hello(sock, "tab-de", { locale: "ja" });
    await hello(sock, "tab-de", { locale: 42 });
    expect(bridge.tabLocale("tab-de")).toBe("en");
    sock.close();
  });

  it("carries the language across a workflow switch, which re-hellos under a NEW tab id", async () => {
    // The per-workflow re-hello is a same-SOCKET, different-ID event, so plain same-socket
    // inheritance cannot see the retiring conn — it has already been deleted and re-keyed.
    // Switching workflows must not silently drop a user back into English mid-session.
    const sock = await open();
    await hello(sock, "wf:route1:/a.json", { locale: "ko" });
    expect(bridge.tabLocale("wf:route1:/a.json")).toBe("ko");
    await hello(sock, "wf:route1:/b.json");
    expect(bridge.tabLocale("wf:route1:/b.json")).toBe("ko");
    sock.close();
  });

  it("does not let a DIFFERENT socket TAKING OVER a live tab id inherit the old one's language", async () => {
    // `wf:` tab ids recur, and a second browser tab can take over a live one. The takeover
    // is a different browser tab whose language we have not been told — English, not the
    // previous tenant's. The first socket stays OPEN on purpose: only then is the outgoing
    // conn still in `conns` and the inherit-vs-discard branch actually reached (with it
    // closed the record is already gone and the test would pass without proving anything).
    const first = await open();
    await hello(first, "wf:recycled", { locale: "ru" });
    expect(bridge.tabLocale("wf:recycled")).toBe("ru");
    const second = await open();
    await hello(second, "wf:recycled");
    expect(bridge.tabLocale("wf:recycled")).toBe("en");
    first.close();
    second.close();
  });

  it("resolves through the same prefix path a push takes, so the language matches the recipient", async () => {
    // Frames route by exact id OR unambiguous prefix; the locale must follow the SAME
    // resolution or a bubble can arrive in a language its tab never asked for.
    const sock = await open();
    await hello(sock, "tab-prefix-9999", { locale: "es" });
    expect(bridge.tabLocale("tab-prefix")).toBe("es");
    sock.close();
  });
});

describe("say frames degrade to English rather than failing", () => {
  it("renders the start-failure notice in English when the tab's language is unknown", () => {
    // No catalogs are installed in this repo, so every locale renders its English fallback —
    // the assertion that matters is that the TEXT IS INTACT, never a raw key.
    const { frames } = buildStartFailureNotice("tab-1::custom", "ECONNREFUSED", "claude");
    const say = frames[0] as { type: string; text: string };
    expect(say.type).toBe("say");
    expect(say.text).toBe(
      "⚠️ The custom agent could not start: ECONNREFUSED — " +
        "Check the base URL and API key in Settings → Custom endpoint, then Disconnect → Connect to retry.",
    );
  });

  it("renders intact text for a locale with no catalog, and never a key or an empty bubble", () => {
    for (const locale of ["ko", "ar", "zh-TW", "kl-GL", "", "not-a-locale"]) {
      const { frames } = buildStartFailureNotice("tab-1::openrouter", "401", "claude", locale);
      const text = (frames[0] as { text: string }).text;
      expect(text).toContain("OPENROUTER_API_KEY");
      expect(text).not.toContain("say.");
      expect(text).not.toContain("{");
    }
  });

  it("keeps the ⚠️ status marker outside the translatable span", () => {
    // The emoji is what the eye and the panel's bubble styling key on; it means the same
    // thing in every language and must survive a catalog that translates the prose.
    const { frames } = buildStartFailureNotice("t::claude", "boom", "claude", "ja");
    expect((frames[0] as { text: string }).text.startsWith("⚠️ ")).toBe(true);
  });

  it("leaves the ack and turn frames alone — they are machine state, not prose", () => {
    // `kind` is string-matched by the panel and these read as machine errors; translating
    // them would break the parse while looking like a courtesy.
    const { frames } = buildStartFailureNotice("t::claude", "boom", "claude", "ko");
    expect(frames[1]).toEqual({ type: "ack", ok: false, kind: "degraded" });
    expect(frames[2]).toEqual({ type: "turn", state: "done" });
  });

  it("passes the provider label and env var through untranslated — they are typed, not read", () => {
    const hint = startFailureHint("moonshot", "ru");
    expect(hint).toContain("MOONSHOT_API_KEY");
  });

  it("renders a counted string from a plain-string fallback, so English keeps its '(s)' hedge", () => {
    // The lost-completion notice passes `{ count }` with a STRING fallback: a catalog may
    // still supply `_one`/`_few`/`_other` forms, while English stays byte-identical to what
    // it said before this unit. If the count path ever stopped falling back to a plain
    // string, that notice would render empty — in the middle of reporting a data loss.
    expect(
      trFor("ru", "say.restart_lost.withheld", "{count} further answer(s) on this tab", {
        count: 3,
      }),
    ).toBe("3 further answer(s) on this tab");
    expect(
      trFor("ko", "say.restart_lost.runs", "{count} result(s) ({runs})", {
        count: 1,
        runs: "a; b",
      }),
    ).toBe("1 result(s) (a; b)");
  });
});

/**
 * The mechanism above is only worth having if the CALL SITES use it, and nothing else in the
 * suite would notice if one stopped: a deleted `trFor(` wrapper leaves correct English, a
 * passing type-check and a green run — the string is simply never translatable again. The
 * same hole swallows a NEW `say` site added later by someone who has not read this file.
 *
 * So this asserts on the SOURCE, with an ENUMERATED exemption list rather than a keyword
 * heuristic: a keyword ("text:", "message") would quietly excuse a genuinely untranslated
 * site, which is exactly the failure it exists to catch. Each exemption must still MATCH
 * something — a stale one that no longer corresponds to real code is itself a failure, or the
 * list would silently grant amnesty to whatever moved into its place.
 */
const srcOf = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

/** `say` sites whose text is composed elsewhere, each with the reason it is not wrapped here. */
const SAY_EXEMPTIONS: Array<{ file: string; fragment: string; why: string }> = [
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text: build("en") }`,
    why: "pushSayToConversation's own park path — `build` IS the translator",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text: build(bridge.tabLocale(t)) }`,
    why: "pushSayToConversation's own fan-out — `build` IS the translator",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text, id: meta?.id`,
    why: "the AGENT's own reply text — a model wrote it, in whatever language it was asked in",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text: corrected }`,
    why: "bannerCorrection() in ready-banner.ts owns that string",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text: parts.join(" ") }`,
    why: "the parts are each trFor'd where they are built, a few lines above",
  },
  {
    file: "orchestrator/index.ts",
    fragment: "${sync.message}",
    why: "panel-sync owns that message; only the ⚠️ marker is added here",
  },
  {
    file: "orchestrator/index.ts",
    fragment: "readyBannerText(backend, bannerLabel, customBaseUrl)",
    why: "ready-banner.ts owns the greeting",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `{ type: "say", text: degradedText }`,
    why: "degradedText is assembled with trFor in the ternary chain just above",
  },
  {
    file: "orchestrator/index.ts",
    fragment: `announce: (text) => void bridge.push({ type: "say", text })`,
    why: "self-restarter owns the update announcement, and it broadcasts to every tab",
  },
];

describe("every say frame is wired to the per-tab translator", () => {
  for (const file of ["orchestrator/index.ts", "services/ui-bridge.ts"]) {
    it(`${file}: no untranslated say site`, () => {
      const src = srcOf(file);
      const exemptions = SAY_EXEMPTIONS.filter((e) => e.file === file);
      const unmatched = new Set(exemptions.map((e) => e.fragment));
      const marker = `type: "say"`;
      const sites: number[] = [];
      for (let at = src.indexOf(marker); at !== -1; at = src.indexOf(marker, at + marker.length)) {
        sites.push(at);
      }
      for (const [n, at] of sites.entries()) {
        // Bounded by the NEXT say site, not by a fixed character budget. A fixed window let a
        // neighbouring translated frame vouch for an untranslated one — verified by mutation:
        // an untranslated say inserted immediately before a translated one passed. Ending the
        // window where the next frame begins makes each site answer for itself.
        const next = sites[n + 1] ?? src.length;
        const body = src.slice(at, Math.min(next, at + 900));
        // A tight collar for the exemptions: an exempt fragment can start just before the
        // marker (`announce: (text) => …`) or land just after it (`${sync.message}`), but it
        // must belong to THIS frame — a wide window would let one exemption excuse the frame
        // next to it. Every exemption visible here counts as USED, not just the first: two
        // say sites can sit three lines apart (pushSayToConversation's park and fan-out paths
        // do), and claiming only one would report the other as stale forever.
        const collar = src.slice(Math.max(0, at - 80), at + 120);
        const matched = exemptions.filter((e) => collar.includes(e.fragment));
        for (const e of matched) unmatched.delete(e.fragment);
        if (matched.length === 0) {
          expect(
            body,
            `an untranslated say frame at ${file}:${src.slice(0, at).split("\n").length} — ` +
              "wrap it in trFor(bridge.tabLocale(<tab>), …), or add it to SAY_EXEMPTIONS with a reason",
          ).toContain("trFor(");
        }
      }
      expect(
        sites.length,
        `no say frames found in ${file} — the marker must have changed`,
      ).toBeGreaterThan(0);
      expect(
        [...unmatched],
        "stale SAY_EXEMPTIONS entries: they match no code, so they excuse whatever moved in",
      ).toEqual([]);
    });
  }

  it("uses trFor (the destination tab's language), never tr (the terminal's)", () => {
    // `tr()` follows LANG/--lang on the machine running the orchestrator. A say frame naming
    // "Settings → OpenRouter" in the server operator's language points at a control the
    // panel's user cannot find — the whole reason those two calls are separate.
    for (const file of [
      "orchestrator/index.ts",
      "services/ui-bridge.ts",
      "orchestrator/start-failure-notice.ts",
    ]) {
      expect(srcOf(file), `${file} must import trFor`).toMatch(/import \{[^}]*\btrFor\b/);
      expect(srcOf(file), `${file} must not use the process-locale tr()`).not.toMatch(
        /[^A-Za-z0-9_.$]tr\(/,
      );
    }
  });

  it("fans the start-failure say out PER TAB instead of pre-rendering one language", () => {
    // #884's conversation spans every tab on the failed backend, and the composite key is
    // usually the SCOPE address `orchestrator::<backend>` — so there is no single "owning
    // tab" whose locale would be right. Deleting this one line leaves the notice correct in
    // English, the type-check clean and the suite green; nothing else would notice.
    expect(srcOf("orchestrator/index.ts")).toMatch(
      /pushSayToConversation\(key, \(locale\) => startFailureSay\(/,
    );
  });

  it("keys every say string under the say. prefix, once", () => {
    const src =
      srcOf("orchestrator/index.ts") +
      srcOf("services/ui-bridge.ts") +
      srcOf("orchestrator/start-failure-notice.ts");
    const keys = [...src.matchAll(/trFor\([\s\S]{0,80}?"([a-z][\w.]*)"/g)].map((m) => m[1]);
    expect(keys.length, "no trFor keys found — the say frames lost their wrappers").toBeGreaterThan(20);
    for (const k of keys) {
      expect(k, `${k} is not under the say. prefix this unit owns`).toMatch(/^say\./);
    }
    // Two sentences sharing one key would give them one translation and lose a meaning.
    expect(new Set(keys).size, `duplicate say keys: ${keys.join(", ")}`).toBe(keys.length);
  });
});
