/**
 * Sonata runs in the demo on the browser worker
 * (research/2026-11-04-global-sonata-in-browser-demo.md, Verification).
 *
 * In `/demo`, it:
 *
 *  1. opens the launcher inside the embed and picks Sonata: the embed switches
 *     to Sonata, whose library lists the demo's songs ("Lumen theme", "Night
 *     mode") and the MIDI starters a fresh install has ("Für Elise"), with
 *     the starters' covers drawn by the worker (loaded through the transport
 *     as blob URLs, never from the page's origin);
 *  2. opens "Für Elise" and plays two notes on its keyboard: each press
 *     starts a sampled voice (an `AudioBufferSourceNode` started), and the
 *     samples come through the worker's asset mirror, whose fetch of the
 *     instrument's public CDN is the only sample traffic;
 *  3. presses Space twice: the transport plays, then pauses (the play button
 *     reads Pause, then Play) — the embedded app's surface-scoped shortcuts
 *     answer as in a tab, not the host page's.
 *
 * And asserts, throughout, that the page itself never moved and nothing left
 * the scope — the list `no-leak.ts` checks against (D3): no `/api/…` request
 * for the page's origin but the sanctioned telemetry routes, no page socket,
 * no page or console error.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/apps/plugins/demo/e2e/sonata-in-demo.ts [--out /tmp/demo-sonata] [--headed]
 */
import type { Locator, Page, Request, WebSocket } from "playwright";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  type Settled,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const OUT = arg("out") ?? "/tmp/demo-sonata";

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

/** The demo's songs (`website/demos/lumen`'s `core/internal/songs.ts`) and a MIDI starter. */
const DEMO_SONGS = ["Lumen theme", "Night mode"] as const;
const STARTER = "Für Elise";
/** Middle C and the E above it. */
const KEYS = [60, 64] as const;
/** The piano's samples, as the worker's asset mirror fetches them. */
const SAMPLE_CDN = "smpldsnds.github.io";
/** How long an app swap, a worker read or a sample load gets. */
const RENDER_TIMEOUT_MS = 30_000;

function embedRoot(page: Page): Locator {
  return page.locator("[data-app-embed]").first();
}

/**
 * Counts every sampled voice started, installed before the page's scripts run
 * (smplr starts an `AudioBufferSourceNode` per voice).
 */
async function tapVoices(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __voicesStarted: number };
    w.__voicesStarted = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (
      this: AudioBufferSourceNode,
      ...args: Parameters<AudioBufferSourceNode["start"]>
    ) {
      w.__voicesStarted += 1;
      return start.apply(this, args);
    };
  });
}

async function voicesStarted(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __voicesStarted?: number }).__voicesStarted ?? 0,
  );
}

await withBrowser(async (h) => {
  const r = report("demo: Sonata on the browser worker");
  const { page, captured } = await h.session();
  await tapVoices(page);

  await boot(page, pathUrl("/demo"), {
    marker: 'button:has-text("Conversations")',
  });

  const leaked: string[] = [];
  const samples: string[] = [];
  const onRequest = (req: Request): void => {
    const url = new URL(req.url());
    if (url.host === SAMPLE_CDN) samples.push(url.pathname);
    if (url.origin !== new URL(page.url()).origin) return;
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

  // ── 1. launcher → Sonata, its library ───────────────────────────────────
  await embedRoot(page)
    .getByRole("button", { name: "All apps" })
    .first()
    .hover();
  const menu = page.locator('[aria-label="Apps"]').last();
  await menu.waitFor({ timeout: 5_000 });
  const tile = menu
    .locator('[data-row-key][role="button"]')
    .filter({ hasText: /^\s*Sonata\s*$/ })
    .first();
  await renders(
    "the launcher offers Sonata",
    () => tile.count(),
    (n) => n > 0,
  );
  await tile.click();
  await page.keyboard.press("Escape");
  await page.mouse.move(0, 0);
  await renders(
    "the embed switches to Sonata",
    () => embedRoot(page).getAttribute("data-app-embed"),
    (id) => id === "sonata",
  );
  for (const title of [...DEMO_SONGS, STARTER]) {
    await renders(
      `the library lists "${title}"`,
      () => embedRoot(page).getByText(title, { exact: true }).count(),
      (n) => n > 0,
    );
  }
  await renders(
    "the MIDI covers are drawn by the worker (blob URLs)",
    () => embedRoot(page).locator('img[src^="blob:"]').count(),
    (n) => n > 0,
  );
  r.eq("the page URL stays /demo", new URL(page.url()).pathname, "/demo");
  await snap(page, OUT, "1-library");

  // ── 2. open a song, play two notes ──────────────────────────────────────
  await embedRoot(page).getByText(STARTER, { exact: true }).first().click();
  const keyboard = embedRoot(page).locator(`[data-pitch="${KEYS[0]}"]`);
  await keyboard.first().waitFor({ timeout: RENDER_TIMEOUT_MS });
  await renders(
    "the song opens with its keyboard",
    () => keyboard.count(),
    (n) => n > 0,
  );
  // The keyboard warms the piano up as it mounts; a key pressed before its
  // samples are in is silent (as on the desktop). Wait for the loads to land
  // and go quiet.
  await renders(
    "the piano's samples load through the worker",
    async () => {
      const seen = samples.length;
      await page.waitForTimeout(1_500);
      return seen > 0 && samples.length === seen ? seen : 0;
    },
    (n) => n > 0,
  );
  for (const pitch of KEYS) {
    const before = await voicesStarted(page);
    await embedRoot(page).locator(`[data-pitch="${pitch}"]`).first().click();
    await renders(
      `pressing key ${pitch} starts a sampled voice`,
      () => voicesStarted(page),
      (n) => n > before,
    );
  }
  await snap(page, OUT, "2-played");

  // ── 3. Space plays, Space pauses ────────────────────────────────────────
  const transport = (label: string): Locator =>
    embedRoot(page).getByRole("button", { name: label, exact: true });
  await renders(
    "the transport rests on Play",
    () => transport("Play").count(),
    (n) => n > 0,
  );
  await page.keyboard.press("Space");
  await renders(
    "Space starts the song (the button reads Pause)",
    () => transport("Pause").count(),
    (n) => n > 0,
  );
  await snap(page, OUT, "3-playing");
  await page.keyboard.press("Space");
  await renders(
    "Space pauses it again (the button reads Play)",
    () => transport("Play").count(),
    (n) => n > 0,
  );

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
