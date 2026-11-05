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
 *  2. opens "Für Elise" and plays two notes on its keyboard: the first the
 *     moment the keyboard shows (before the samples are in, as a visitor
 *     would) — it must still start a sampled voice (an
 *     `AudioBufferSourceNode` started) once they are, never stay silent — and
 *     the second once the piano's samples are decoded. The samples come through the worker's
 *     asset mirror and never from the page: this context is fresh (the
 *     harness opens a new one per run), so the mirror's cache is empty and
 *     the worker fetches each sample from the instrument's public CDN (all
 *     answered), while the page itself requests no sample at all;
 *  3. presses Space twice: the transport plays, then pauses (the play button
 *     reads Pause, then Play) — the embedded app's surface-scoped shortcuts
 *     answer as in a tab, not the host page's;
 *  4. leaves the demo until its worker has ended, and does 1–3 again in the
 *     same context: the mirror's cache is the host's `data-files` store, kept
 *     in IndexedDB (`browser-server/host-storage`), so the piano sounds again
 *     with NO CDN request — a returning visitor never downloads a sample twice.
 *
 * The worker is a SharedWorker, which Playwright never attaches to: its
 * requests reach no `page.on("request")` (counting those saw zero samples on a
 * working demo). They are read from the browser's own CDP
 * (`tapSharedWorkerRequests`).
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
import { isWorkerTreePath } from "@plugins/framework/plugins/tooling/plugins/web-artifacts/core";
import {
  arg,
  boot,
  pathUrl,
  report,
  snap,
  tapSharedWorkerRequests,
  waitFor,
  waitForNetworkIdle,
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

/** The demo's host: the SharedWorker loaded from a worker tree (the page's own
 * SharedWorkers — live sockets, the stall watch — are vite worker chunks). */
function isHost(workerUrl: string): boolean {
  return isWorkerTreePath(new URL(workerUrl).pathname);
}

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

/**
 * Counts every audio buffer decoded (smplr decodes each sample it loads), so
 * "the samples are in" is read the same way whichever source served them.
 */
async function tapDecodes(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __buffersDecoded: number };
    w.__buffersDecoded = 0;
    const decode = BaseAudioContext.prototype.decodeAudioData;
    BaseAudioContext.prototype.decodeAudioData = function (
      this: BaseAudioContext,
      ...args: Parameters<BaseAudioContext["decodeAudioData"]>
    ) {
      return decode.apply(this, args).then((buffer) => {
        w.__buffersDecoded += 1;
        return buffer;
      });
    };
  });
}

async function buffersDecoded(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __buffersDecoded?: number }).__buffersDecoded ??
      0,
  );
}

async function voicesStarted(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as unknown as { __voicesStarted?: number }).__voicesStarted ?? 0,
  );
}

await withBrowser(async (h) => {
  const r = report("demo: Sonata on the browser worker");
  // Before the page exists: a worker's requests are seen from its attach on.
  const worker = await tapSharedWorkerRequests(h.browser);
  const { page, captured } = await h.session();
  await tapVoices(page);
  await tapDecodes(page);

  // The page's own boot reads its shell's resources — some (Mail's sync
  // state, the Settings conflict dot) after the demo shows when the demo
  // boots fast, as it does warm. Once the demo is up and the page has gone
  // quiet, every /api request the page itself sends is recorded.
  let demoUp: string | null = null;
  const leaked: string[] = [];
  /** Sample requests the page itself made — the mirror's job, never the page's. */
  const pageSamples: string[] = [];
  const onRequest = (req: Request): void => {
    const url = new URL(req.url());
    if (url.host === SAMPLE_CDN) pageSamples.push(url.pathname);
    if (demoUp === null || url.origin !== new URL(page.url()).origin) return;
    if (!url.pathname.startsWith("/api/")) return;
    if (!SANCTIONED.some((re) => re.test(url.pathname)))
      leaked.push(`${demoUp}: ${req.method()} ${url.pathname}`);
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

  const cdnRequests = () =>
    worker.requests.filter((req) => new URL(req.url).host === SAMPLE_CDN);

  /** /demo → launcher → Sonata → "Für Elise" → two notes; `pass` names the run. */
  const playFurElise = async (pass: string): Promise<void> => {
    await boot(page, pathUrl("/demo"), {
      marker: 'button:has-text("Conversations")',
    });
    await waitForNetworkIdle(page);
    demoUp = pass;
    await renders(
      `${pass}: the demo's worker is recorded`,
      async () => worker.workers().filter((w) => isHost(w.url) && w.recording),
      (hosts) => hosts.length > 0,
    );

    // ── 1. launcher → Sonata, its library ─────────────────────────────────
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
      `${pass}: the launcher offers Sonata`,
      () => tile.count(),
      (n) => n > 0,
    );
    await tile.click();
    await page.keyboard.press("Escape");
    await page.mouse.move(0, 0);
    await renders(
      `${pass}: the embed switches to Sonata`,
      () => embedRoot(page).getAttribute("data-app-embed"),
      (id) => id === "sonata",
    );
    for (const title of [...DEMO_SONGS, STARTER]) {
      await renders(
        `${pass}: the library lists "${title}"`,
        () => embedRoot(page).getByText(title, { exact: true }).count(),
        (n) => n > 0,
      );
    }
    await renders(
      `${pass}: the MIDI covers are drawn by the worker (blob URLs)`,
      () => embedRoot(page).locator('img[src^="blob:"]').count(),
      (n) => n > 0,
    );
    r.eq(
      `${pass}: the page URL stays /demo`,
      new URL(page.url()).pathname,
      "/demo",
    );
    await snap(page, OUT, `${pass}-1-library`);

    // ── 2. open a song, play two notes ────────────────────────────────────
    await embedRoot(page).getByText(STARTER, { exact: true }).first().click();
    const keyboard = embedRoot(page).locator(`[data-pitch="${KEYS[0]}"]`);
    await keyboard.first().waitFor({ timeout: RENDER_TIMEOUT_MS });
    await renders(
      `${pass}: the song opens with its keyboard`,
      () => keyboard.count(),
      (n) => n > 0,
    );
    // The first key goes down as soon as the keyboard shows — before the
    // piano's samples are in, unless they beat the click — and must still
    // sound: a press waits for the load, never drops (live-play's engine).
    const [first, second] = KEYS;
    const decodedAtPress = await buffersDecoded(page);
    const before = await voicesStarted(page);
    await embedRoot(page).locator(`[data-pitch="${first}"]`).first().click();
    r.note(
      `${pass}: key ${first} pressed with ${decodedAtPress} buffer(s) decoded`,
    );
    await renders(
      `${pass}: key ${first}, pressed at once, sounds once the samples are in`,
      () => voicesStarted(page),
      (n) => n > before,
    );
    // Wait for the decodes to land and go quiet, then play a second note.
    await renders(
      `${pass}: the piano's samples are decoded`,
      async () => {
        const seen = await buffersDecoded(page);
        await page.waitForTimeout(1_500);
        return seen > 0 && (await buffersDecoded(page)) === seen ? seen : 0;
      },
      (n) => n > 0,
    );
    const beforeSecond = await voicesStarted(page);
    await embedRoot(page).locator(`[data-pitch="${second}"]`).first().click();
    await renders(
      `${pass}: pressing key ${second} starts a sampled voice`,
      () => voicesStarted(page),
      (n) => n > beforeSecond,
    );
    await snap(page, OUT, `${pass}-2-played`);

    // ── 3. Space plays, Space pauses ──────────────────────────────────────
    const transport = (label: string): Locator =>
      embedRoot(page).getByRole("button", { name: label, exact: true });
    await renders(
      `${pass}: the transport rests on Play`,
      () => transport("Play").count(),
      (n) => n > 0,
    );
    await page.keyboard.press("Space");
    await renders(
      `${pass}: Space starts the song (the button reads Pause)`,
      () => transport("Pause").count(),
      (n) => n > 0,
    );
    await snap(page, OUT, `${pass}-3-playing`);
    await page.keyboard.press("Space");
    await renders(
      `${pass}: Space pauses it again (the button reads Play)`,
      () => transport("Play").count(),
      (n) => n > 0,
    );
  };

  // ── cold: a fresh context, the mirror fetches from the CDN ────────────────
  await playFurElise("cold");

  // ── warm: the worker gone, its cache kept — no sample downloaded again ────
  // Attached, the workers would outlive the page (see tapSharedWorkerRequests).
  await worker.release();
  const cold = cdnRequests();
  r.ok(
    "cold: the worker's asset mirror fetched the samples from the CDN",
    cold.length > 0 && cold.every((req) => isHost(req.worker)),
    `${cold.length} request(s), from ${[...new Set(cold.map((req) => req.worker))].join(", ")}`,
  );
  r.eq(
    "cold: every CDN sample fetch was answered, none failed or refused",
    cold.filter(
      (req) =>
        req.failed !== undefined ||
        req.status === undefined ||
        req.status >= 400,
    ),
    [],
  );
  demoUp = null;
  await page.goto("about:blank");
  await renders(
    "the demo's workers end once no page holds them",
    async () => worker.workers().map((w) => w.url),
    (urls) => urls.length === 0,
  );
  await playFurElise("warm");
  r.eq(
    "warm: the samples come from the mirror's kept cache, no CDN request",
    cdnRequests()
      .slice(cold.length)
      .map((req) => req.url),
    [],
  );

  page.off("request", onRequest);
  page.off("websocket", onSocket);
  await worker.stop();

  r.eq("the page itself requested no sample", pageSamples, []);
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
