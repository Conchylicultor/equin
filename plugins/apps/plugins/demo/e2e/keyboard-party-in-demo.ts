/**
 * Keyboard Party runs in the demo
 * (research/2026-11-06-global-keyboard-party-in-browser-demo.md, Verification).
 *
 * In `/demo`, it:
 *
 *  1. opens the launcher inside the embed and picks Tap Tap Party: the embed
 *     switches to the party's stage, which takes the keyboard focus itself;
 *  2. presses a letter, a digit, Space and an arrow: each plays its effect
 *     (the effects layer fills), leaves its bead on the trail, and sounds —
 *     every sound is synthesized with WebAudio (a scheduled source started per
 *     note) — and the letter is spoken through the browser's own
 *     `speechSynthesis` ("A, Apple"); the keys are the toy's, so the page URL
 *     stays `/demo`;
 *  3. opens the party settings and picks the Sunny meadow scene: the stage's
 *     backdrop follows — a config write answered by the demo's worker — and,
 *     after a reload, the scene is still the one picked (the worker's config
 *     is kept in the demo's IndexedDB);
 *  4. leaves through the app launcher its grown-up corner draws (the embed
 *     has no rail or tab bar to leave by) to the Desktop: the party becomes a
 *     window, keys
 *     pressed in it still play; its titlebar's Full screen fills the embed with
 *     the stage, and keys pressed there play too.
 *
 * And asserts, throughout, that nothing left the scope — the list `no-leak.ts`
 * checks against (D3): no `/api/…` request for the page's origin but the
 * sanctioned telemetry routes, no page socket, no page or console error.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/keyboard-party-in-demo.ts [--out /tmp/demo-keyboard-party] [--headed]
 */
import type { Locator, Page, Request, WebSocket } from "playwright";
import { pickFromLauncher } from "@plugins/apps-core/plugins/app-launcher/e2e";
import { shownWindowIds } from "@plugins/apps/plugins/desktop/plugins/windows/e2e";
import {
  arg,
  pathUrl,
  report,
  snap,
  waitFor,
  waitForNetworkIdle,
  withBrowser,
  type Settled,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  AGENT_MANAGER_LOCATION,
  demoPath,
  onDemoPage,
  bootDemo,
} from "./internal/demo-pages";

const OUT = arg("out") ?? "/tmp/demo-keyboard-party";

/** The page-origin `/api` routes a demo may still call — `no-leak.ts`'s list (D3). */
const SANCTIONED: readonly RegExp[] = [
  /^\/api\/logs\/emit$/,
  /^\/api\/latency-ledger\/client$/,
  /^\/api\/slow-ops\/client$/,
  /^\/api\/app-usage\/flush$/,
  /^\/api\/analytics\/collect$/,
  /^\/api\/reports$/,
  /^\/api\/icons\/(sprite|symbols)\//,
  /^\/api\/health(\/ready)?$/,
];

/** The app's launcher name and id (`apps/keyboard-party/shell`'s `keyboardPartyApp`). */
const APP_NAME = /^\s*Tap Tap Party\s*$/;
const APP_ID = "keyboard-party";
/** A key each of four kinds (`party/core`'s `classifyKey`), and the bead each leaves. */
const KEYS = [
  { key: "a", bead: "A" },
  { key: "3", bead: "3" },
  { key: "Space", bead: "␣" },
  { key: "ArrowRight", bead: "→" },
] as const;
/** How long an app swap, a worker read or a mode switch gets. */
const RENDER_TIMEOUT_MS = 30_000;

function embedRoot(page: Page): Locator {
  return page.locator("[data-app-embed]").first();
}

function stage(page: Page): Locator {
  return embedRoot(page).locator(".kp-stage").first();
}

/**
 * Counts every WebAudio source started (the party's oscillators and noise
 * buffers) and records every utterance instead of speaking it — installed
 * before the page's scripts run.
 */
async function tapSound(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __sourcesStarted: number;
      __spoken: string[];
    };
    w.__sourcesStarted = 0;
    w.__spoken = [];
    // AudioBufferSourceNode (the noises) declares its own `start`; the
    // oscillators inherit AudioScheduledSourceNode's.
    for (const proto of [
      AudioScheduledSourceNode.prototype,
      AudioBufferSourceNode.prototype,
    ]) {
      const start = proto.start;
      proto.start = function (
        this: AudioScheduledSourceNode,
        ...args: Parameters<AudioScheduledSourceNode["start"]>
      ) {
        w.__sourcesStarted += 1;
        return start.apply(this, args);
      };
    }
    speechSynthesis.speak = (u: SpeechSynthesisUtterance) => {
      w.__spoken.push(u.text);
    };
  });
}

async function sound(
  page: Page,
): Promise<{ started: number; spoken: string[] }> {
  return page.evaluate(() => {
    const w = window as unknown as {
      __sourcesStarted?: number;
      __spoken?: string[];
    };
    return { started: w.__sourcesStarted ?? 0, spoken: w.__spoken ?? [] };
  });
}

async function beads(page: Page): Promise<string[]> {
  return embedRoot(page)
    .locator(".kp-bead")
    .evaluateAll((els) => els.map((el) => el.textContent ?? ""));
}

async function stageHasFocus(page: Page): Promise<boolean> {
  return stage(page).evaluate((el) => document.activeElement === el);
}

await withBrowser(async (h) => {
  const r = report("demo: Keyboard Party on the browser worker");
  const { page, captured } = await h.session();
  await tapSound(page);

  let demoUp = false;
  const leaked: string[] = [];
  const onRequest = (req: Request): void => {
    const url = new URL(req.url());
    if (!demoUp || url.origin !== new URL(page.url()).origin) return;
    if (!url.pathname.startsWith("/api/")) return;
    if (!SANCTIONED.some((re) => re.test(url.pathname)))
      leaked.push(`${req.method()} ${url.pathname}`);
  };
  page.on("request", onRequest);
  const openedSockets: string[] = [];
  const onSocket = (ws: WebSocket): void => {
    openedSockets.push(new URL(ws.url()).pathname);
  };
  page.on("websocket", onSocket);

  const renders = async <T>(
    name: string,
    read: () => Promise<T>,
    ok: (value: T) => boolean,
  ): Promise<Settled<T>> => {
    const settled = await waitFor(read, ok, { timeoutMs: RENDER_TIMEOUT_MS });
    r.ok(
      name,
      settled.ok,
      `${JSON.stringify(settled.value)} (waited ${settled.waitedMs} ms)`,
    );
    return settled;
  };

  /** /demo → launcher → Tap Tap Party; `pass` names the run. */
  const openParty = async (pass: string): Promise<void> => {
    await bootDemo(page, pathUrl(demoPath(AGENT_MANAGER_LOCATION)), {
      marker: 'button:has-text("Conversations")',
    });
    // Counted from once the page's OWN chrome has booted (its deferred tier
    // mounted, its requests answered), as no-leak takes its baseline: the
    // demo can be up before the page around it is, and the page's chrome
    // reading its own server is not the demo's traffic.
    await page.waitForFunction(
      () =>
        performance.getEntriesByName("boot:deferred-load-complete").length > 0,
      undefined,
      { timeout: RENDER_TIMEOUT_MS },
    );
    await waitForNetworkIdle(page);
    demoUp = true;
    r.ok(
      `${pass}: the launcher offers Tap Tap Party`,
      await pickFromLauncher(embedRoot(page), APP_NAME),
    );
    await renders(
      `${pass}: the embed switches to Keyboard Party`,
      () => embedRoot(page).getAttribute("data-app-embed"),
      (id) => id === APP_ID,
    );
    await stage(page).waitFor({ timeout: RENDER_TIMEOUT_MS });
  };

  /** Press `keys` on whatever holds focus; each must play, bead and sound. */
  const pressAll = async (
    pass: string,
    keys: readonly { key: string; bead: string }[],
  ): Promise<void> => {
    for (const { key, bead } of keys) {
      const before = await beads(page);
      const soundBefore = (await sound(page)).started;
      await page.keyboard.press(key);
      await renders(
        `${pass}: ${key} leaves its bead "${bead}" on the trail`,
        () => beads(page),
        // The trail keeps as many beads as fit, so it may drop its oldest.
        (now) => now.at(-1) === bead && now.join() !== before.join(),
      );
      await renders(
        `${pass}: ${key} sounds (a WebAudio source started)`,
        async () => (await sound(page)).started,
        (n) => n > soundBefore,
      );
    }
  };

  // ── 1. launcher → Tap Tap Party ─────────────────────────────────────────
  await openParty("open");
  await renders(
    "the stage takes the keyboard focus itself",
    () => stageHasFocus(page),
    (focused) => focused,
  );
  await snap(page, OUT, "1-stage");

  // ── 2. keys play, bead, sound and speak ─────────────────────────────────
  await pressAll("embed", KEYS);
  await renders(
    "the effects layer draws what the keys played",
    () => embedRoot(page).locator(".kp-layer > *").count(),
    (n) => n > 0,
  );
  await renders(
    "the letter is spoken through the browser's speechSynthesis",
    async () => (await sound(page)).spoken,
    (spoken) => spoken.some((text) => /\bApple\b/.test(text)),
  );
  r.ok("the page stays on the demo", onDemoPage(page.url()), page.url());
  await snap(page, OUT, "2-played");

  // ── 3. settings: the scene, written to the worker's config ──────────────
  r.eq(
    "the stage opens on the default scene",
    await embedRoot(page).locator(".kp-root").getAttribute("data-scene"),
    "night",
  );
  await embedRoot(page)
    .getByRole("button", { name: "Party settings" })
    .first()
    .click();
  await page.getByText("Sunny meadow", { exact: true }).first().click();
  await renders(
    "picking Sunny meadow repaints the stage",
    () => embedRoot(page).locator(".kp-root").getAttribute("data-scene"),
    (scene) => scene === "sunny",
  );
  await page.keyboard.press("Escape");
  await snap(page, OUT, "3-sunny");
  demoUp = false;
  await openParty("reload");
  await renders(
    "reload: the scene picked is still the stage's (the worker's config is kept)",
    () => embedRoot(page).locator(".kp-root").getAttribute("data-scene"),
    (scene) => scene === "sunny",
  );

  // ── 4. leave through the party's launcher: a Desktop window ────────────
  r.ok(
    "the party's corner draws the app launcher, which offers Desktop",
    await pickFromLauncher(embedRoot(page), /^\s*Desktop\s*$/),
  );
  await renders(
    "the embed is a desktop: the party is its one window",
    () => shownWindowIds(embedRoot(page)),
    (ids) => ids.length === 1,
  );
  await stage(page).focus();
  await pressAll("window", [KEYS[0], KEYS[1]]);
  await snap(page, OUT, "4-window");

  const fullScreen = embedRoot(page).getByRole("button", {
    name: "Full screen",
    exact: true,
  });
  await fullScreen.first().click();
  await renders(
    "Full screen leaves no window: the stage fills the embed",
    () => shownWindowIds(embedRoot(page)),
    (ids) => ids.length === 0,
  );
  await stage(page).focus();
  await pressAll("full screen", [KEYS[2], KEYS[3]]);
  r.ok("the page stays on the demo", onDemoPage(page.url()), page.url());
  await snap(page, OUT, "4-full-screen");

  page.off("request", onRequest);
  page.off("websocket", onSocket);
  r.eq(
    "no /api request left for the page's origin (sanctioned telemetry aside)",
    leaked,
    [],
  );
  r.eq("the page opened no socket of its own", openedSockets, []);
  r.eq("no page errors", captured.pageErrors, []);
  r.eq("no console errors", captured.consoleErrors, []);
  await r.finish();
});
