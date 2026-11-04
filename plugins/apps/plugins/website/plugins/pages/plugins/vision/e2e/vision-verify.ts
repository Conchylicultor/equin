// Verifies the Vision zoom (`/website/vision`) against its mock
// (`proto-1792811767-vd1ygi`, at its picked options: fit b, copy paragraphs,
// os orbit): the behaviour a pixel diff at rest cannot see.
//
//   - the heading fills the first screen and the layer strip is hidden;
//   - the six chapter cards are there, the empty-`before` ones with one paragraph;
//   - reading each chapter (its card at the middle of the pane) lights that card,
//     shows the strip with that chapter's number and name, and puts that frame
//     of the zoom on screen; the heading has dissolved;
//   - the frames animate on their own (a frame's drawing changes over time while
//     the page is still);
//   - each chapter is photographed, one file per chapter, for a side-by-side
//     pass against the prototype.
//
// Usage:
//   ./equin run plugins/apps/plugins/website/plugins/pages/plugins/vision/e2e/vision-verify.ts \
//     [--out /tmp/vision] [--width 1400] [--height 900] [--color-scheme dark|light] [--headed]
//
// Manual only — nothing runs this automatically.

import type { Page } from "playwright";
import {
  arg,
  boot,
  numArg,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const out = arg("out", "/tmp/vision");
const width = numArg("width", 1400);
const height = numArg("height", 900);
const colorScheme = arg("color-scheme", "dark") === "light" ? "light" : "dark";

const NAMES = [
  "An idea",
  "Ideas change the app",
  "Apps integrate",
  "A personal OS",
  "Shared",
  "Every app",
];

interface State {
  cards: number;
  paragraphs: number[];
  lit: number;
  strip: { live: boolean; label: string };
  heroOpacity: number;
  /** Which frames' drawings are visible. */
  fronts: boolean[];
  /** How far chapter k's card centre is from the pane's middle. */
  offsets: number[];
}

async function state(page: Page): Promise<State> {
  return page.evaluate(() => {
    const root = document.querySelector<HTMLElement>(".vision-zoom");
    let scroller: HTMLElement | null = root?.parentElement ?? null;
    while (
      scroller &&
      !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)
    )
      scroller = scroller.parentElement;
    const sr = scroller?.getBoundingClientRect();
    const mid = (sr?.top ?? 0) + (scroller?.clientHeight ?? 0) / 2;
    const cards = [...document.querySelectorAll<HTMLElement>(".vs-card")];
    const strip = document.querySelector<HTMLElement>(".vs-strip");
    const hero = document.querySelector<HTMLElement>(".vision-zoom-hero");
    return {
      cards: cards.length,
      paragraphs: cards.map((c) => c.querySelectorAll("p").length),
      lit: [...document.querySelectorAll(".vs-step")].findIndex((s) =>
        s.classList.contains("is-on"),
      ),
      strip: {
        live: strip?.classList.contains("is-live") ?? false,
        label: strip?.querySelector(".vs-strip-label")?.textContent ?? "",
      },
      heroOpacity: hero ? Number(getComputedStyle(hero).opacity) : -1,
      fronts: [...document.querySelectorAll<HTMLElement>(".z-front")].map(
        (f) => f.style.visibility === "visible",
      ),
      offsets: cards.map((c) => {
        const r = c.getBoundingClientRect();
        return r.top + r.height / 2 - mid;
      }),
    };
  });
}

/** Scroll the pane by wheel until chapter k's card sits at its middle. */
async function readChapter(page: Page, k: number): Promise<void> {
  for (let i = 0; i < 6; i++) {
    const dy = (await state(page)).offsets[k] ?? 0;
    if (Math.abs(dy) < 4) break;
    await page.mouse.move(width / 2, height / 2);
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(900);
}

/** A frame's drawing, as markup, to tell whether it moves on its own. */
const drawing = (page: Page, k: number) =>
  page.evaluate(
    (i) => document.querySelectorAll(".z-front")[i]?.innerHTML ?? "",
    k,
  );

await withBrowser(async (h) => {
  const r = report("vision zoom");
  const { page } = await h.session({
    viewport: { width, height },
    colorScheme,
  });
  await boot(page, pathUrl("/website/vision"), {
    marker: "text=A vision for",
    settleMs: 1500,
  });

  const top = await state(page);
  r.ok("six chapter cards", top.cards === 6, JSON.stringify(top.paragraphs));
  r.ok(
    "the chapters with no 'before' show one paragraph",
    JSON.stringify(top.paragraphs) === JSON.stringify([2, 2, 2, 1, 2, 1]),
    JSON.stringify(top.paragraphs),
  );
  r.ok(
    "at the top the strip is hidden",
    !top.strip.live,
    JSON.stringify(top.strip),
  );
  r.ok(
    "at the top the heading is whole",
    top.heroOpacity === 1,
    String(top.heroOpacity),
  );
  r.ok(
    "at the top the idea's frame is on screen",
    top.fronts[0] === true,
    JSON.stringify(top.fronts),
  );
  await snap(page, out, "top");

  for (let k = 0; k < NAMES.length; k++) {
    await readChapter(page, k);
    const s = await state(page);
    r.ok(`chapter ${k}: its card is lit`, s.lit === k, `lit ${s.lit}`);
    r.ok(
      `chapter ${k}: the strip reads 0${k} ${NAMES[k]}`,
      s.strip.live && s.strip.label === `0${k}${NAMES[k]}`,
      JSON.stringify(s.strip),
    );
    r.ok(
      `chapter ${k}: its frame is on screen`,
      s.fronts[k] === true,
      JSON.stringify(s.fronts),
    );
    r.ok(
      `chapter ${k}: the heading has dissolved`,
      s.heroOpacity === 0,
      String(s.heroOpacity),
    );
    if (k === 1 || k === 4) {
      const a = await drawing(page, k);
      const moved = await waitFor(
        () => drawing(page, k),
        (b) => b !== a,
        { timeoutMs: 3000, intervalMs: 200 },
      );
      r.ok(`chapter ${k}: the frame animates on its own`, moved.ok, "");
    }
    await snap(page, out, `chapter-${k}`);
  }

  await r.finish();
});
