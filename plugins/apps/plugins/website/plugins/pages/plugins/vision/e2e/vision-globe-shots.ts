// Photographs the Vision zoom's last chapter (the globe) at fixed scroll
// positions and fixed animation times — deterministic frames, the same pixels
// on every run of the same code — so a change to how the globe is drawn can be
// diffed against what it drew before.
//
// Determinism: the page runs on Playwright's fake clock, paused before the
// scroll, so the globe's own clock (advanced by requestAnimationFrame's dt)
// only moves under `clock.runFor` — in 16 ms frames, the same sequence every
// run; its arcs come from a seeded generator. The scroll is set exactly (the
// scrollTop that puts progress p where asked, from the cards' centres and the
// reading line), never wheeled. CSS animations and transitions are settled by
// the screenshot (`animations: "disabled"`). Each shot is the pinned stage.
//
// Usage:
//   ./equin run plugins/apps/plugins/website/plugins/pages/plugins/vision/e2e/vision-globe-shots.ts \
//     --out <dir> [--width 1400] [--height 900] [--color-scheme dark|light] \
//     [--against <dir> [--fail-above <pct>]] [--page-url <prototype page URL>] [--headed]
//
// Writes `<out>/<shot>.png`. With `--against <dir>` (an earlier run's --out),
// diffs each shot with the same-named one there and writes
// `<out>/<shot>-diff.png` and `<out>/<shot>-side-by-side.png`, logging the
// differing-pixel ratio per shot. `--page-url` photographs another page laid out the
// same way (the prototype the page mocks: it scrolls the window and reads its
// cards at the screen's middle) instead of this checkout's deploy.
//
// Manual only — nothing runs this automatically.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import {
  arg,
  boot,
  diffImages,
  heatmapText,
  numArg,
  pathUrl,
  requireArg,
  TOAST,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = requireArg(
  "out",
  "vision-globe-shots.ts --out <dir> [--width] [--height] [--color-scheme] [--against <dir>] [--page-url <url>]",
);
const width = numArg("width", 1400);
const height = numArg("height", 900);
const colorScheme = arg("color-scheme", "dark") === "light" ? "light" : "dark";
const against = arg("against");
const failAbove = numArg("fail-above", 100);
const pageUrl = arg("page-url");
/** Hide these elements in every shot (a CSS selector) — to tell which layer a difference is in. */
const hide = arg("hide");

/**
 * One shot: progress p, then `ms` more of animation time. Shots run in order on
 * one page, so a later shot's time adds to the earlier ones' at the same p.
 * Every `ms` is a whole number of the fake clock's 16 ms frames: otherwise a
 * run fires one frame more or less depending on where its frames fall (their
 * phase is set by the real time the clock was paused at).
 */
const FRAME_MS = 16;
const SHOTS: { name: string; p: number; frames: number }[] = [
  { name: "p4.40-t2.0", p: 4.4, frames: 125 },
  { name: "p4.70-t3.0", p: 4.7, frames: 63 },
  { name: "p5.00-t3.0", p: 5, frames: 1 },
  { name: "p5.00-t4.0", p: 5, frames: 63 },
  { name: "p5.00-t8.0", p: 5, frames: 250 },
  { name: "p5.00-t16.0", p: 5, frames: 500 },
];

/** Must match ladder-scroll's HOLD (a card holds its chapter within HOLD × screen of the line). */
const HOLD = 0.15;

/** Scroll so the zoom's progress is exactly p (between chapters 4 and 5, or at 5). */
async function scrollToP(page: Page, p: number): Promise<void> {
  // resolved once the scroll event has been dispatched: the page measures p on the frame after it
  // (a fake-clock frame), so the clock may only run from here on
  await page.evaluate(
    ({ p, HOLD }) => {
      const cards = [...document.querySelectorAll<HTMLElement>(".vs-card")];
      if (cards.length !== 6)
        throw new Error(`vision: ${cards.length} chapter cards`);
      let scroller: HTMLElement | null = cards[0]!.parentElement;
      // the nearest ancestor that scrolls (a body styled overflow:auto that does not is passed over)
      while (
        scroller &&
        !(
          /(auto|scroll)/.test(getComputedStyle(scroller).overflowY) &&
          scroller.scrollHeight > scroller.clientHeight + 1
        )
      )
        scroller = scroller.parentElement;
      const el = scroller ?? document.scrollingElement;
      if (!(el instanceof HTMLElement)) throw new Error("vision: no scroller");
      const top = scroller ? el.getBoundingClientRect().top : 0;
      const screen = el.clientHeight;
      // the app publishes its reading line; the prototype reads at the screen's middle
      const pub = document
        .querySelector<HTMLElement>(".vision-zoom")
        ?.style.getPropertyValue("--vs-read");
      const read = pub ? Number.parseFloat(pub) : screen / 2;
      const hold = screen * HOLD;
      // the cards' centres at scrollTop 0, in the scroller's viewport
      const c = cards.map((card) => {
        const r = card.getBoundingClientRect();
        return r.top - top + r.height / 2 + el.scrollTop;
      });
      const y =
        p >= 5
          ? c[5]! - read
          : c[4]! + hold + (p - 4) * (c[5]! - c[4]! - 2 * hold) - read;
      const target = Math.round(y);
      if (Math.round(el.scrollTop) === target) return;
      const scrolled = new Promise<void>((done) =>
        (scroller ?? window).addEventListener("scroll", () => done(), {
          once: true,
        }),
      );
      el.scrollTop = target;
      return scrolled;
    },
    { p, HOLD },
  );
}

await withBrowser(async (h) => {
  const { page } = await h.session({
    viewport: { width, height },
    colorScheme,
  });
  await page.clock.install();
  await boot(page, pageUrl ?? pathUrl("/about/vision"), {
    marker: ".vs-stage",
    settleMs: 2500,
  });
  await page.clock.pauseAt(Date.now() + 60_000);
  // not the drawing: the app's toasts (a slow-op report), and the agent-worktree deploy frame (main
  // has none, so a worktree's shots would differ from main's by it)
  await page.addStyleTag({
    content: `${TOAST}, [data-sonner-toaster] { display: none !important; }`,
  });
  await page.evaluate(() =>
    document.documentElement.classList.add("experimental-marks-off"),
  );
  if (hide)
    await page.addStyleTag({ content: `${hide} { opacity: 0 !important; }` });
  mkdirSync(out, { recursive: true });
  const ratios: [string, number][] = [];
  for (const s of SHOTS) {
    await scrollToP(page, s.p);
    await page.clock.runFor(s.frames * FRAME_MS);
    const png = await page
      .locator(".vs-stage")
      .screenshot({ animations: "disabled" });
    writeFileSync(join(out, `${s.name}.png`), png);
    if (!against) continue;
    const ref = join(against, `${s.name}.png`);
    if (!existsSync(ref)) throw new Error(`no ${ref} to diff against`);
    const d = await diffImages(page, readFileSync(ref), png, {
      labels: ["before", "after"],
    });
    writeFileSync(join(out, `${s.name}-diff.png`), d.diffPng);
    writeFileSync(join(out, `${s.name}-side-by-side.png`), d.sideBySidePng);
    ratios.push([s.name, d.ratio]);
    console.log(
      `${s.name}: ${(d.ratio * 100).toFixed(3)}% differing (${d.differing}/${d.total} px${d.sameSize ? "" : `, sizes ${d.a.width}x${d.a.height} vs ${d.b.width}x${d.b.height}`})`,
    );
    console.log(heatmapText(d.grid));
  }
  console.log(`wrote ${SHOTS.length} shots to ${out}`);
  const worst = Math.max(0, ...ratios.map((r) => r[1] * 100));
  return worst <= failAbove;
});
