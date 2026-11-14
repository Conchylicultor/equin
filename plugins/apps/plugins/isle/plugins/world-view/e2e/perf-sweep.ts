// How smooth the island is on THIS checkout's deploy: the long tasks before it
// is ready (the title card's Start enables), then a pan / zoom sweep (drags in
// four directions, wheel out and back in) with every animation frame's
// interval recorded. Prints the longest frame, p50 / p95 frame intervals and
// the long tasks, for comparing a change to the renderer before and after.
//
// Usage:
//   ./equin run plugins/apps/plugins/isle/plugins/world-view/e2e/perf-sweep.ts \
//     [--apps <n> [--bake workers|page]] [--runs 3] [--out "$EQUIN_SCRATCH/isle-perf"]
//
// Without --apps it drives /isle (the real apps; presses Start). With --apps it
// drives the growth exhibit (`isle/growth`, the dev plugin) at that many apps:
// it sets the count, rebuilds the world from scratch and waits for it to be
// drawn — what the long tasks are counted against there. --bake page flips the
// exhibit's Bake switch first: every bake on the page, for a before/after.

import {
  arg,
  numArg,
  pathUrl,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";

const apps = arg("apps");
const bake = arg("bake", "workers");
const runs = numArg("runs", 3);
const out = arg("out", "/tmp/isle-perf");
const VIEW = { width: 1280, height: 800 };

// The recorder runs in the page, so its accumulator is a page global (read back by evaluate).
type PerfWindow = Window & {
  __islePerf?: { lt: [number, number][]; frames: number[] };
};

function installRecorder(): void {
  const w = window as PerfWindow;
  const rec = { lt: [] as [number, number][], frames: [] as number[] };
  w.__islePerf = rec;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) rec.lt.push([e.startTime, e.duration]);
  }).observe({ type: "longtask", buffered: true });
  const tick = (t: number) => {
    rec.frames.push(t);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

const now = (page: Page) => page.evaluate(() => performance.now());

async function readyOnIsle(page: Page): Promise<number> {
  await page.goto(pathUrl("/isle"));
  const start = page.getByRole("button", { name: "Start", exact: true });
  await start.waitFor({ timeout: 120_000 });
  const handle = await page.waitForFunction(
    () => {
      const b = [...document.querySelectorAll("button")].find(
        (x) => x.textContent?.trim() === "Start",
      );
      return b && !b.disabled ? performance.now() : 0;
    },
    undefined,
    { timeout: 180_000, polling: "raf" },
  );
  const t = (await handle.jsonValue()) as number;
  await start.click({ force: true });
  return t;
}

async function readyOnExhibit(page: Page, n: number): Promise<number> {
  await page.goto(pathUrl("/debug/exhibit-stage/isle/growth"));
  const count = page.getByLabel("Apps", { exact: true });
  await count.waitFor({ timeout: 120_000 });
  await count.fill(String(n));
  await count.press("Enter");
  if (bake === "page")
    await page.getByRole("button", { name: "Bake: workers" }).click();
  await page.getByRole("button", { name: "Rebuild" }).click();
  const t0 = await now(page);
  const handle = await page.waitForFunction(
    (since) => {
      const el = document.querySelector("[data-isle-ready]");
      const at = Number(el?.getAttribute("data-isle-ready") ?? 0);
      return at > since ? at : 0;
    },
    t0,
    { timeout: 180_000, polling: "raf" },
  );
  return (await handle.jsonValue()) as number;
}

async function sweep(page: Page): Promise<void> {
  const cx = VIEW.width / 2;
  const cy = VIEW.height / 2;
  for (const [dx, dy] of [
    [-520, 0],
    [0, -380],
    [520, 0],
    [0, 380],
    [-700, -300],
  ] as const) {
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 24; i++)
      await page.mouse.move(cx + (dx * i) / 24, cy + (dy * i) / 24);
    await page.mouse.up();
    await page.waitForTimeout(700);
  }
  for (const d of [300, 300, 300, 300, -300, -300, -300, -300, -300])
    await page.mouse.wheel(0, d).then(() => page.waitForTimeout(260));
  await page.waitForTimeout(1500);
}

const pct = (xs: number[], p: number) =>
  xs.length
    ? [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)]!
    : NaN;
const f = (x: number) => x.toFixed(1);

await withBrowser(async (h) => {
  const rows: string[] = [];
  for (let run = 1; run <= runs; run++) {
    const { page } = await h.session({ viewport: VIEW, colorScheme: "light" });
    await page.addInitScript(installRecorder);
    const ready =
      apps === undefined
        ? await readyOnIsle(page)
        : await readyOnExhibit(page, Number(apps));
    const from = apps === undefined ? 0 : ready - 1e9; // exhibit: long tasks since its rebuild, below
    await page.waitForTimeout(2500);
    const idleFrom = await now(page);
    await page.waitForTimeout(2000);
    const sweepFrom = await now(page);
    await sweep(page);
    const sweepTo = await now(page);
    if (run === 1) await snap(page, out, `run${run}`);
    const workers = page
      .workers()
      .map((w) => w.url())
      .filter((u) => u.includes("bake.worker"));
    const rec = await page.evaluate(() => (window as PerfWindow).__islePerf!);
    const span = (a: number, b: number) => {
      const fr = rec.frames.filter((t) => t >= a && t <= b);
      return fr.slice(1).map((t, i) => t - fr[i]!);
    };
    const idle = span(idleFrom, sweepFrom);
    const sw = span(sweepFrom, sweepTo);
    const rebuildAt =
      apps === undefined
        ? 0
        : await page.evaluate(() =>
            Number(
              document
                .querySelector("[data-isle-rebuilt]")
                ?.getAttribute("data-isle-rebuilt") ?? 0,
            ),
          );
    const before = rec.lt.filter(
      ([t]) => t >= (apps === undefined ? from : rebuildAt) && t < ready,
    );
    const during = rec.lt.filter(([t]) => t >= sweepFrom && t <= sweepTo);
    rows.push(
      `run ${run}: ready ${f(ready - (apps === undefined ? 0 : rebuildAt))} ms · ` +
        `long tasks before ready ${before.length} (sum ${f(before.reduce((s, [, d]) => s + d, 0))} ms, max ${f(Math.max(0, ...before.map(([, d]) => d)))} ms) · ` +
        `idle frame p50 ${f(pct(idle, 0.5))} p95 ${f(pct(idle, 0.95))} · ` +
        `sweep frame p50 ${f(pct(sw, 0.5))} p95 ${f(pct(sw, 0.95))} max ${f(Math.max(...sw))} ms · ` +
        `long tasks in sweep ${during.length} (max ${f(Math.max(0, ...during.map(([, d]) => d)))} ms) · ` +
        `bake workers ${workers.length}`,
    );
    await page.context().close();
  }
  console.log(
    `\nisle perf (${apps === undefined ? "/isle" : `exhibit, ${apps} apps`}):`,
  );
  for (const r of rows) console.log(`  ${r}`);
});
