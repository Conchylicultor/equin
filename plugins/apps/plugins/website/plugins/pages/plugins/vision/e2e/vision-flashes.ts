// Finds one-frame flashes in the Vision zoom (`/website/vision`): a chapter is
// scrolled to its card and then played FRAME BY FRAME on a fake clock —
// requestAnimationFrame is taken over before the page loads, and each step runs
// the queued callbacks at now + 1/fps — and every frame is photographed. A
// flash is a frame unlike both its neighbours while they are alike: its score is
// how far it is from the nearer neighbour minus how far the neighbours are from
// each other (mean luminance difference, 0–255), in the worst 16px block of the
// stage — a flash can be small — and over the whole picture. Real time
// cannot show it: a headless browser drops frames, a phone does not.
//
// Prints the worst frames (loop time, score) and writes them, with their
// neighbours, to --out. CSS animations are stepped on the same fake clock.
//
// Usage:
//   ./equin run plugins/apps/plugins/website/plugins/pages/plugins/vision/e2e/vision-flashes.ts \
//     [--chapter 2] [--seconds 23] [--fps 60] [--width 390] [--height 844] [--dpr 1] [--gpu]
//     [--out /tmp/vision-flashes] [--top 8] [--hide cursor,ripple] [--realtime --no-record]
//     [--read 0.77]
//
// --read puts the card's centre at that fraction of the screen's height instead of on the page's
// own reading line (needed for a build from before it, e.g. an older equin.ai release).
//
// --realtime leaves the page on its own clock and films it with a screencast (every frame the
// compositor produces, the whole viewport): what stepping cannot show — frames that interleave with
// scroll / resize callbacks, CSS animations on their own clock, dropped frames.
//
// --dpr renders at that device pixel ratio (a phone, or DevTools' device mode: 2–3); --gpu rasterizes
// on the machine's GPU, as the user's Chrome does, instead of the headless software path.
//
// Manual only — nothing runs this automatically.

import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "playwright";
import {
  arg,
  boot,
  numArg,
  pathUrl,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const chapter = numArg("chapter", 2);
const seconds = numArg("seconds", 23);
const fps = numArg("fps", 60);
const width = numArg("width", 390);
const height = numArg("height", 844);
const out = arg("out", "/tmp/vision-flashes");
const top = numArg("top", 8);
const dpr = numArg("dpr", 1);
const gpu = process.argv.includes("--gpu");
const realtime = process.argv.includes("--realtime");
/** Where the card is read, as a fraction of the screen's height — instead of the page's own reading line. */
const readAt = numArg("read", -1);
if (realtime && !process.argv.includes("--no-record"))
  throw new Error(
    "vision-flashes: --realtime films the page with its own screencast — pass --no-record too (the harness recorder's would take its frames)",
  );
/** Parts hidden while capturing (id suffixes): a small thing moving fast reads as a flash in every block it crosses. */
const hide = arg("hide", "cursor,ripple").split(",").filter(Boolean);

/** Take requestAnimationFrame over: real until `__visionManual()`, then only `__visionStep(ms)` runs frames. */
const clockShim = () => {
  const w = window as unknown as Record<string, unknown>;
  const real = window.requestAnimationFrame.bind(window);
  const cancelReal = window.cancelAnimationFrame.bind(window);
  let manual = false;
  let now = 0;
  let next = 1;
  const queue = new Map<number, FrameRequestCallback>();
  const realIds = new Map<number, { r: number; cb: FrameRequestCallback }>();
  window.requestAnimationFrame = (cb) => {
    const id = next++;
    if (manual) queue.set(id, cb);
    else
      realIds.set(id, {
        cb,
        r: real((t) => {
          realIds.delete(id);
          cb(t);
        }),
      });
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    queue.delete(id);
    const r = realIds.get(id);
    if (r) cancelReal(r.r);
    realIds.delete(id);
  };
  w.__visionManual = () => {
    manual = true;
    now = performance.now();
    // frames already asked for run on the fake clock from now on
    for (const [id, r] of realIds) {
      cancelReal(r.r);
      realIds.delete(id);
      queue.set(id, r.cb);
    }
  };
  w.__visionStep = (ms: number) => {
    now += ms;
    // CSS animations step on the same clock (one started since — a drawing remounted — is caught here)
    for (const a of document.getAnimations()) {
      if (a.playState === "running") a.pause();
      a.currentTime = Number(a.currentTime ?? 0) + ms;
    }
    const due = [...queue.values()];
    queue.clear();
    for (const cb of due) cb(now);
  };
};

/** Scroll the pane by wheel until chapter k's card sits on the reading line. */
async function readChapter(page: Page, k: number): Promise<void> {
  for (let i = 0; i < 8; i++) {
    const dy = await page.evaluate(
      ([i, readAt]) => {
        const card = document.querySelectorAll<HTMLElement>(".vs-card")[i];
        if (!card) throw new Error(`no chapter card ${i}`);
        let scroller: HTMLElement | null = card.parentElement;
        while (
          scroller &&
          !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
        )
          scroller = scroller.parentElement;
        const read =
          readAt >= 0
            ? readAt * (scroller?.clientHeight ?? 0)
            : Number.parseFloat(
                document
                  .querySelector<HTMLElement>(".vision-zoom")
                  ?.style.getPropertyValue("--vs-read") ?? "",
              );
        if (!Number.isFinite(read))
          throw new Error(
            "vision: no --vs-read on .vision-zoom (a build before the reading line: pass --read <fraction>)",
          );
        const r = card.getBoundingClientRect();
        return (
          r.top +
          r.height / 2 -
          (scroller?.getBoundingClientRect().top ?? 0) -
          read
        );
      },
      [k, readAt] as const,
    );
    if (Math.abs(dy) < 4) break;
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(900);
}

await withBrowser(
  async (h) => {
    const { page } = await h.session({
      viewport: { width, height },
      deviceScaleFactor: dpr,
    });
    await page.addInitScript(clockShim);
    await boot(page, pathUrl("/website/vision"), {
      marker: "text=A vision for",
      settleMs: 1500,
    });
    await readChapter(page, chapter);
    const box = await page.locator(".vs-stage").boundingBox();
    if (!box) throw new Error("vision: no stage");
    const clip = {
      x: box.x,
      y: Math.max(0, box.y),
      width: box.width,
      height: Math.min(box.height, height),
    };
    await page.evaluate((hide) => {
      for (const n of hide)
        for (const e of document.querySelectorAll<SVGElement>(
          `.vision-zoom [id$="-${n}"]`,
        ))
          e.style.display = "none";
    }, hide);
    if (!realtime)
      await page.evaluate(() =>
        (window as unknown as { __visionManual(): void }).__visionManual(),
      );
    // each frame is decoded and compared as it is taken, in a blank page: mean luminance difference
    // over a 4px grid to the frame before (prev) and to the one before that (skip, for the frame before)
    const cmp = await h.session({ viewport: { width: 200, height: 200 } });
    await cmp.page.evaluate(() => {
      const w = window as unknown as Record<string, unknown>;
      let L: number[][] = [];
      const dist = (a: number[], b: number[]) => {
        let s = 0;
        for (let i = 0; i < a.length; i++) s += Math.abs(a[i]! - b[i]!);
        return s / a.length;
      };
      w.__add = async (b64: string) => {
        const blob = await (await fetch(`data:image/png;base64,${b64}`)).blob();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const g = c.getContext("2d")!;
        g.drawImage(bmp, 0, 0);
        const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
        const v: number[] = [];
        for (let y = 0; y < bmp.height; y += 4)
          for (let x = 0; x < bmp.width; x += 4) {
            const i = (y * bmp.width + x) * 4;
            v.push(0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!);
          }
        L = [...L.slice(-2), v];
        // the frame before, as a flash: per 16px block (4 x 4 samples), how far it is from the nearer
        // neighbour beyond how far its neighbours are from each other — the worst block
        let local = 0;
        if (L.length > 2) {
          const [a, b, c] = L as [number[], number[], number[]];
          const cols = Math.ceil(bmp.width / 4);
          const rows = Math.ceil(bmp.height / 4);
          for (let by = 0; by < rows; by += 4)
            for (let bx = 0; bx < cols; bx += 4) {
              let ab = 0;
              let bc = 0;
              let ac = 0;
              let n = 0;
              for (let y = by; y < Math.min(rows, by + 4); y++)
                for (let x = bx; x < Math.min(cols, bx + 4); x++) {
                  const i = y * cols + x;
                  ab += Math.abs(a[i]! - b[i]!);
                  bc += Math.abs(b[i]! - c[i]!);
                  ac += Math.abs(a[i]! - c[i]!);
                  n++;
                }
              local = Math.max(local, (Math.min(ab, bc) - ac) / n);
            }
        }
        return {
          prev: L.length > 1 ? dist(v, L[L.length - 2]!) : 0,
          skip: L.length > 2 ? dist(v, L[0]!) : 0,
          local,
        };
      };
    });
    // the frames: stepped on the fake clock and photographed one by one, or (--realtime) the page
    // left to run on its own clock, filmed by a screencast that sends every frame the compositor makes
    const shots: { png: Buffer; t: number }[] = [];
    if (realtime) {
      const cdp = await page.context().newCDPSession(page);
      let t0: number | null = null;
      cdp.on("Page.screencastFrame", (f) => {
        const t = f.metadata.timestamp ?? 0;
        t0 ??= t;
        shots.push({ png: Buffer.from(f.data, "base64"), t: t - t0 });
        void cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId });
      });
      await cdp.send("Page.startScreencast", {
        format: "png",
        everyNthFrame: 1,
      });
      await page.waitForTimeout(seconds * 1000);
      await cdp.send("Page.stopScreencast");
    } else {
      const n = Math.round(seconds * fps);
      for (let i = 0; i < n; i++) {
        await page.evaluate(
          (ms) =>
            (
              window as unknown as { __visionStep(ms: number): void }
            ).__visionStep(ms),
          1000 / fps,
        );
        shots.push({
          png: await page.screenshot({ clip, type: "png" }),
          t: (i + 1) / fps,
        });
        if (i % fps === 0) console.log(`  frame ${i}/${n}`);
      }
    }
    const n = shots.length;
    /** prev: frame i vs i - 1; skip: frame i - 1's neighbours (i - 2 vs i). */
    const diffs: { prev: number; skip: number; local: number }[] = [];
    for (let i = 0; i < n; i++) {
      const d = await cmp.page.evaluate(
        (b64) =>
          (
            window as unknown as {
              __add(
                b: string,
              ): Promise<{ prev: number; skip: number; local: number }>;
            }
          ).__add(b64),
        shots[i]!.png.toString("base64"),
      );
      diffs.push({ prev: d.prev, skip: 0, local: 0 });
      if (i >= 1) {
        diffs[i - 1]!.skip = d.skip;
        diffs[i - 1]!.local = d.local;
      }
    }
    const scored = diffs
      .map((d, i) => {
        const next = diffs[i + 1]?.prev ?? 0;
        return { i, score: d.local, whole: Math.min(d.prev, next) - d.skip };
      })
      .filter((s) => s.i > 0 && s.i < diffs.length - 1)
      .sort((a, b) => b.score - a.score);
    mkdirSync(out, { recursive: true });
    console.log(
      `chapter ${chapter}, ${n} frames ${realtime ? `in ${seconds} s, real time` : `at ${fps} fps`} (${width}x${height} @${dpr}x${gpu ? ", gpu" : ""}); mean frame-to-frame change ${(
        diffs.reduce((a, d) => a + d.prev, 0) / diffs.length
      ).toFixed(2)}`,
    );
    for (const s of scored.slice(0, top)) {
      console.log(
        `  frame ${s.i} (t = ${shots[s.i]!.t.toFixed(3)} s): worst 16px block ${s.score.toFixed(1)}, whole picture ${s.whole.toFixed(2)}`,
      );
      for (const j of [s.i - 1, s.i, s.i + 1])
        writeFileSync(
          `${out}/f${String(j).padStart(5, "0")}.png`,
          shots[j]!.png,
        );
    }
    console.log(`worst frames and their neighbours in ${out}`);
  },
  { gpu },
);
