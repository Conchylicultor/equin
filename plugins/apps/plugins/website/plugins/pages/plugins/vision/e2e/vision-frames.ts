// Measures what the Vision zoom (`/website/vision`) costs a frame while it
// plays on its own: for each chapter, scrolled to its card and then left
// alone, the frame rate, the long animation frames (count, mean, worst; the
// style + layout share; script time by invoker) and the DOM writes per second
// the zoom makes — the before/after numbers for a change to its animation or
// to anything that watches the DOM (the render-loop detector).
//
// Usage:
//   ./equin run plugins/apps/plugins/website/plugins/pages/plugins/vision/e2e/vision-frames.ts \
//     [--seconds 3] [--width 1400] [--height 900] [--headed]
//
// Manual only — nothing runs this automatically.

import type { Page } from "playwright";
import {
  boot,
  numArg,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const seconds = numArg("seconds", 3);
const width = numArg("width", 1400);
const height = numArg("height", 900);

interface FrameStats {
  fps: number;
  writesPerSec: number;
  longFrames: number;
  longMeanMs: number;
  longMaxMs: number;
  styleLayoutMeanMs: number;
  scriptByInvoker: [string, number][];
}

/** Scroll the pane by wheel until chapter k's card sits at its middle. */
async function readChapter(page: Page, k: number): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const dy = await page.evaluate((i) => {
      const card = document.querySelectorAll<HTMLElement>(".vs-card")[i];
      if (!card) throw new Error(`no chapter card ${i}`);
      let scroller: HTMLElement | null = card.parentElement;
      while (
        scroller &&
        !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
      )
        scroller = scroller.parentElement;
      const sr = scroller?.getBoundingClientRect();
      const mid = (sr?.top ?? 0) + (scroller?.clientHeight ?? 0) / 2;
      const r = card.getBoundingClientRect();
      return r.top + r.height / 2 - mid;
    }, k);
    if (Math.abs(dy) < 4) break;
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(900);
}

/** One window of the page left alone: frames, long frames and DOM writes. */
const measure = (page: Page, ms: number): Promise<FrameStats> =>
  page.evaluate(async (ms) => {
    let writes = 0;
    const mo = new MutationObserver((rs) => {
      writes += rs.length;
    });
    mo.observe(document.body, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
    const long: PerformanceEntry[] = [];
    const po = new PerformanceObserver((l) => long.push(...l.getEntries()));
    po.observe({ type: "long-animation-frame" });
    let frames = 0;
    const t0 = performance.now();
    await new Promise<void>((done) => {
      const tick = () => {
        frames++;
        if (performance.now() - t0 < ms) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });
    mo.disconnect();
    po.disconnect();
    type Script = {
      invoker: string;
      sourceFunctionName: string;
      duration: number;
    };
    type Loaf = PerformanceEntry & {
      styleAndLayoutStart: number;
      scripts: Script[];
    };
    const loafs = long as Loaf[];
    const byInvoker = new Map<string, number>();
    for (const f of loafs)
      for (const s of f.scripts) {
        const key = `${s.invoker} ${s.sourceFunctionName}`.trim();
        byInvoker.set(key, (byInvoker.get(key) ?? 0) + s.duration);
      }
    const n = loafs.length || 1;
    return {
      fps: Math.round((frames * 1000) / ms),
      writesPerSec: Math.round((writes * 1000) / ms),
      longFrames: loafs.length,
      longMeanMs: Math.round(loafs.reduce((a, f) => a + f.duration, 0) / n),
      longMaxMs: Math.round(Math.max(0, ...loafs.map((f) => f.duration))),
      styleLayoutMeanMs: Math.round(
        loafs.reduce(
          (a, f) => a + (f.startTime + f.duration - f.styleAndLayoutStart),
          0,
        ) / n,
      ),
      scriptByInvoker: [...byInvoker]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => [k, Math.round(v)] as [string, number]),
    };
  }, ms);

await withBrowser(async (h) => {
  const { page } = await h.session({ viewport: { width, height } });
  await boot(page, pathUrl("/website/vision"), {
    marker: "text=A vision for",
    settleMs: 1500,
  });
  for (let k = 0; k < 6; k++) {
    await readChapter(page, k);
    const s = await measure(page, seconds * 1000);
    console.log(`chapter ${k}: ${JSON.stringify(s)}`);
  }
  return true;
});
