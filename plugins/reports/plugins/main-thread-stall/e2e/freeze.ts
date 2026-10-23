/**
 * Verifies the main-thread stall detector end to end against this checkout's
 * deploy:
 *
 *  1. An 8 s busy loop in a visible tab ⇒ one `main-thread-stall` report,
 *     `ended: recovered`, attributed (LoAF) to the injected function.
 *  2. An endless loop in a second tab, then its renderer is killed (CDP
 *     Page.crash — headless Chromium cannot reload or close a hung tab) ⇒
 *     `ended: gone`, `framesDuring: 0`, naming that tab, filed through the
 *     first one.
 *  3. The same in the first tab, whose renderer hosts the watchdog ⇒ the
 *     watchdog dies too; the app opened again adopts its stored record ⇒
 *     `ended: unknown`, lower-bound ≥ 5 s.
 *
 * Reads the reports straight from the deploy's database (refuses main).
 *
 * Manual only. Run after `./singularity build`:
 *   ./singularity run plugins/reports/plugins/main-thread-stall/e2e/freeze.ts --no-record [--headed]
 *
 * `--no-record` is required: the harness's screencast recorder never returns
 * on a hung / crashed page, so a recorded run hangs at the freeze.
 */
import {
  arg,
  boot,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

interface StallRow extends Record<string, unknown> {
  data: {
    ended: string;
    durationMs: number;
    startedAt: number;
    framesDuring: number;
    topFunction: string | null;
    tabId: string;
    durationIsLowerBound: boolean;
  };
  count: number;
}

const PATH = arg("path", "/");
const r = report("main-thread stall → report");
const db = openDeployDb();
onBeforeFinish(() => db.close());

/** Main-thread-stall reports whose newest sighting started after `sinceMs`. */
async function stallsSince(sinceMs: number): Promise<StallRow[]> {
  return db.query<StallRow>(
    `SELECT data, count FROM reports
      WHERE kind = 'main-thread-stall' AND (data->>'startedAt')::bigint >= $1
      ORDER BY (data->>'startedAt')::bigint`,
    [sinceMs],
  );
}

/** Run `body` as a real <script> (not an eval), so LoAF names its function. */
const SPIN = (fn: string, body: string): string =>
  `function ${fn}() { ${body} }\nsetTimeout(${fn}, 0);`;

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await boot(page, pathUrl(PATH), { settleMs: 3000 });
  await waitAttached(page, "first");

  // ── 1. A stall that recovers ──────────────────────────────────────────────
  const t1 = Date.now() - 1000;
  await page.addScriptTag({
    content: SPIN(
      "mtsInjectedSpin",
      "const until = Date.now() + 8000; while (Date.now() < until) {}",
    ),
  });
  const recovered = await waitFor(
    () => stallsSince(t1),
    (rows) => rows.some((x) => x.data.ended === "recovered"),
    { timeoutMs: 40_000, intervalMs: 1000 },
  );
  const rec = recovered.value.find((x) => x.data.ended === "recovered");
  r.ok(
    "an 8 s busy loop files one recovered main-thread-stall report",
    recovered.ok && recovered.value.length === 1,
    JSON.stringify(recovered.value.map((x) => x.data)),
  );
  r.ok(
    "its duration is the LoAF frame's (~8 s)",
    rec !== undefined &&
      rec.data.durationMs >= 7500 &&
      rec.data.durationMs < 10_000,
    String(rec?.data.durationMs),
  );
  r.ok(
    "LoAF attributes it to the injected function",
    rec?.data.topFunction?.includes("mtsInjectedSpin") ?? false,
    String(rec?.data.topFunction),
  );

  // ── 2. A stall that never ends: the frozen tab is killed ────────────────
  // Headless Chromium has no "page unresponsive" path: a reload or close of a
  // hung tab just waits on the renderer, which keeps its Web Locks. So the
  // renderer is killed the way Chrome kills a hung one (CDP Page.crash runs
  // off the renderer's main thread). The watchdog SharedWorker lives in the
  // renderer of the tab that started it (the first one), so the SECOND tab is
  // the one frozen here: the watchdog outlives it and files it through the
  // first tab.
  const firstTabId = rec?.data.tabId;
  const second = await context.newPage();
  await boot(second, pathUrl(PATH), { settleMs: 2000 });
  await waitAttached(second, "second");
  const t2 = Date.now() - 1000;
  await freezeAndKill(second);

  const gone = await waitFor(
    () => stallsSince(t2),
    (rows) => rows.some((x) => x.data.ended === "gone"),
    { timeoutMs: 45_000, intervalMs: 1000 },
  );
  const g = gone.value.find((x) => x.data.ended === "gone");
  r.ok(
    "freeze then kill files a gone report (through the first tab)",
    gone.ok,
    JSON.stringify(gone.value.map((x) => x.data)),
  );
  r.ok(
    "an endless loop completes no frame during the stall",
    g?.data.framesDuring === 0,
    String(g?.data.framesDuring),
  );
  r.ok(
    "it lasted ≥ 5 s",
    g !== undefined && g.data.durationMs >= 5000,
    String(g?.data.durationMs),
  );
  r.ok(
    "it names the frozen (second) tab, not the one that filed it",
    g !== undefined && g.data.tabId !== firstTabId,
    `${g?.data.tabId} vs first ${firstTabId}`,
  );

  // ── 3. The tab hosting the watchdog freezes and is killed: both die ──────
  // Its IndexedDB record of the open stall is adopted by the next watchdog
  // (the app opened again) and filed as `unknown`, a lower-bound duration.
  const t3 = Date.now() - 1000;
  await freezeAndKill(page);
  r.note("opening the app again");
  const again = await context.newPage();
  await boot(again, pathUrl(PATH), { settleMs: 2000 });
  const unknown = await waitFor(
    () => stallsSince(t3),
    (rows) => rows.some((x) => x.data.ended === "unknown"),
    { timeoutMs: 45_000, intervalMs: 1000 },
  );
  const u = unknown.value.find((x) => x.data.ended === "unknown");
  r.ok(
    "the stall the last tab died in is filed on the next start (unknown)",
    unknown.ok,
    JSON.stringify(unknown.value.map((x) => x.data)),
  );
  r.ok(
    "its duration is a lower bound ≥ 5 s",
    u !== undefined && u.data.durationIsLowerBound && u.data.durationMs >= 5000,
    JSON.stringify(u?.data),
  );
});

/**
 * Wait until the tab holds its watchdog port lock — the detector's Core.Root
 * controller mounted and attached (a cold first load after a build can take a
 * while to reach it).
 */
async function waitAttached(p: Page, which: string): Promise<void> {
  const attached = await waitFor(
    () =>
      p.evaluate(async () =>
        (await navigator.locks.query()).held?.some((l) =>
          l.name?.startsWith("singularity:main-thread-stall-port:"),
        ),
      ),
    (v) => v === true,
    { timeoutMs: 60_000, intervalMs: 500 },
  );
  r.ok(
    `the ${which} tab is attached to the watchdog (holds its port lock) — after ${attached.waitedMs} ms`,
    attached.ok,
  );
}

/** Freeze `p` with an endless loop, wait past the report bar, then kill its renderer. */
async function freezeAndKill(p: Page): Promise<void> {
  const cdp = await p.context().newCDPSession(p);
  await p.addScriptTag({ content: SPIN("mtsEndlessSpin", "for (;;) {}") });
  await new Promise((resolve) => setTimeout(resolve, 8000));
  r.note("killing the frozen tab's renderer");
  const crashed = p.waitForEvent("crash", { timeout: 30_000 });
  // The reply never comes: the renderer is gone before it can answer.
  void cdp.send("Page.crash").catch((err: unknown) => {
    r.note(`Page.crash: ${err instanceof Error ? err.message : String(err)}`);
  });
  await crashed;
}

await r.finish();
