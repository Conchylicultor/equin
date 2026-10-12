// ONE selection at a time, and both kinds look the same.
//
// The page editor has two ways to show selected text: the browser's own
// selection inside one block's editing host, and the editor-owned span painted
// with the CSS Custom Highlight API (`page-text-span`) once a selection crosses
// blocks. Two rules, both reported from manual testing and both asserted here:
//
//   A. They never show at once. Whenever the span highlight paints anything,
//      `window.getSelection()` holds no range text — sampled on EVERY step of a
//      cross-block drag (down, back into the origin, after an edge auto-scroll,
//      starting at a line's very edge, and after pointerup), and right after a
//      double- or triple-click made while a span or a block selection is live.
//   B. They look the same: both paint `--text-selection` (color-palette), so the
//      fill behind a native in-block selection and behind the painted span is
//      one colour — and it is a colour, clearly apart from the page background —
//      in BOTH light and dark schemes.
//
// Usage: ./singularity run plugins/page/plugins/editor/e2e/span-native-selection-verify.ts [--url <deploy>]
import {
  colorDistance,
  report,
  samplePixels,
  withBrowser,
  type Rgba,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import {
  blockTexts,
  editableBlocks,
  openBlankPage,
} from "./support/blank-page";
import { blockSelectionDriver } from "./support/block-selection";
import { typeLines } from "./support/type-lines";

const LINES = ["alpha one two", "bravo three four", "charlie five six"];
const r = report();

/** The rect of characters `[from, to)` of block `i`'s first text node. */
async function charRect(
  page: Page,
  i: number,
  from: number,
  to: number,
): Promise<{ x: number; y: number; width: number; height: number }> {
  return editableBlocks(page)
    .nth(i)
    .evaluate(
      (el, [a, b]) => {
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        const text = walker.nextNode();
        if (!text) throw new Error("block has no text node");
        const range = document.createRange();
        range.setStart(text, a!);
        range.setEnd(text, b!);
        const rect = range.getBoundingClientRect();
        return {
          x: rect.left,
          y: rect.top,
          width: rect.width,
          height: rect.height,
        };
      },
      [from, to],
    );
}

async function pointAt(page: Page, i: number, index: number) {
  const r = await charRect(page, i, index, index + 1);
  return { x: r.x + 1, y: r.y + r.height / 2 };
}

/** What is visible right now: painted span text and native selection text. */
function visibleSelections(
  page: Page,
): Promise<{ painted: string; native: string }> {
  return page.evaluate(() => {
    const h = CSS.highlights.get("page-text-span");
    const painted = h ? [...h].map((range) => range.toString()).join("") : "";
    return { painted, native: window.getSelection()?.toString() ?? "" };
  });
}

/** Record every sample where BOTH the span and a native selection show. */
function sampler(page: Page) {
  const both: string[] = [];
  let spanSeen = false;
  return {
    async sample(where: string) {
      const v = await visibleSelections(page);
      if (v.painted !== "") spanSeen = true;
      if (v.painted !== "" && v.native !== "")
        both.push(
          `${where}: span ${JSON.stringify(v.painted)} + native ${JSON.stringify(v.native)}`,
        );
    },
    both,
    spanSeen: () => spanSeen,
  };
}

/**
 * A pressed drag through `path`, sampling after EVERY pointer step (one CSS
 * step at a time is too slow; 4px steps still catch a frame-level re-seat).
 */
async function sampledDrag(
  page: Page,
  s: ReturnType<typeof sampler>,
  label: string,
  from: { x: number; y: number },
  path: { x: number; y: number }[],
  holdAtEndMs = 0,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.waitForTimeout(600);
  let cur = from;
  for (const p of path) {
    const steps = Math.max(
      2,
      Math.ceil(Math.hypot(p.x - cur.x, p.y - cur.y) / 4),
    );
    for (let i = 1; i <= steps; i++) {
      await page.mouse.move(
        cur.x + ((p.x - cur.x) * i) / steps,
        cur.y + ((p.y - cur.y) * i) / steps,
      );
      await s.sample(`${label} step`);
    }
    cur = p;
  }
  for (let t = 0; t < holdAtEndMs; t += 100) {
    await page.waitForTimeout(100);
    await s.sample(`${label} hold`);
  }
  await page.mouse.up();
  await s.sample(`${label} pointerup`);
  await page.waitForTimeout(300);
  await s.sample(`${label} after pointerup`);
}

/** The most frequent colour in a sampled rect: the fill behind the glyphs. */
async function fillColour(
  page: Page,
  rect: { x: number; y: number; width: number; height: number },
): Promise<Rgba> {
  const grid = await samplePixels(page, rect);
  const counts = new Map<string, { c: Rgba; n: number }>();
  for (let y = 0; y < grid.height; y++)
    for (let x = 0; x < grid.width; x++) {
      const c = grid.at(x, y);
      const key = `${c.r},${c.g},${c.b}`;
      const e = counts.get(key);
      if (e) e.n += 1;
      else counts.set(key, { c, n: 1 });
    }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]!.c;
}

await withBrowser(async (h) => {
  // ---- A. one selection at a time ----------------------------------------
  {
    const { page } = await h.session({
      viewport: { width: 1100, height: 700 },
    });
    await openBlankPage(page, { settleMs: 3000 });
    await typeLines(page, LINES);
    await page.waitForTimeout(2000);
    r.eq("setup: three lines", await blockTexts(page), LINES);
    const s = sampler(page);

    // A1. mid-line-1 → mid-line-3, then back into the origin line.
    await sampledDrag(page, s, "A1 down-and-back", await pointAt(page, 0, 6), [
      await pointAt(page, 2, 8),
      await pointAt(page, 1, 4),
      await pointAt(page, 0, 10),
    ]);
    // A2. starting at a line's very first character (the row edge).
    const edge = await charRect(page, 1, 0, 1);
    await sampledDrag(
      page,
      s,
      "A2 from the edge",
      { x: edge.x + 0.5, y: edge.y + edge.height / 2 },
      [await pointAt(page, 2, 5)],
    );
    // A3. upward.
    await sampledDrag(page, s, "A3 upward", await pointAt(page, 2, 10), [
      await pointAt(page, 0, 3),
    ]);
    r.ok("A1–A3: the span was painted during the drags", s.spanSeen());

    // A4. Double- and triple-click while a span is live.
    await sampledDrag(page, s, "A4 setup", await pointAt(page, 0, 6), [
      await pointAt(page, 2, 8),
    ]);
    const word = await pointAt(page, 1, 7);
    await page.mouse.dblclick(word.x, word.y);
    await s.sample("A4 dblclick over a span (immediately)");
    await page.waitForTimeout(300);
    await s.sample("A4 dblclick over a span (settled)");
    r.ok(
      "A4: a double-click over a span selects natively, and the span is gone",
      (await visibleSelections(page)).painted === "" &&
        (await visibleSelections(page)).native.trim().length > 0,
    );
    await sampledDrag(page, s, "A5 setup", await pointAt(page, 0, 6), [
      await pointAt(page, 2, 8),
    ]);
    await page.mouse.click(word.x, word.y, { clickCount: 3 });
    await s.sample("A5 triple-click over a span (immediately)");
    await page.waitForTimeout(300);
    await s.sample("A5 triple-click over a span (settled)");

    // A6. Double-click while a BLOCK selection is live: one selection, too.
    const { selectedCount, enterBlockSelection } = blockSelectionDriver(
      page,
      r,
    );
    // The shared entry dance — it outlasts the documented async focus steal
    // (task-1784221574192-phh891) that otherwise clears a fresh block
    // selection, and proves the container kept focus.
    await enterBlockSelection("A6 setup", 1);
    r.eq("A6 setup: a block selection", await selectedCount(), 1);
    // A word on line 3: the LIVE selection bar pins over the top of the
    // document and swallows pointer events there (see the block-selection
    // driver), so a double-click on line 2 can land on the bar instead. Prove
    // the point is on the text before relying on it.
    const word3 = await pointAt(page, 2, 9); // "five"
    r.ok(
      "A6 setup: the double-click point is on line 3's text",
      await page.evaluate(
        ({ x, y }) =>
          !!document
            .elementFromPoint(x, y)
            ?.closest('[contenteditable="true"]')
            ?.textContent?.includes("charlie"),
        word3,
      ),
    );
    await page.mouse.dblclick(word3.x, word3.y);
    await page.waitForTimeout(300);
    const native = (await visibleSelections(page)).native.trim();
    r.ok(
      "A6: a double-click over a block selection replaces it",
      native.length > 0 && (await selectedCount()) === 0,
      `native ${JSON.stringify(native)}, selected ${await selectedCount()}`,
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);

    // A7. Edge auto-scroll: enough lines that the page scrolls, a drag held at
    // the bottom edge.
    await page.mouse.click(word.x + 200, (await pointAt(page, 2, 0)).y);
    await page.keyboard.press("End");
    await typeLines(
      page,
      Array.from({ length: 24 }, (_, i) => `line number ${i + 4}`),
      { leadingEnter: true },
    );
    await page.waitForTimeout(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    const top = await pointAt(page, 0, 6);
    const viewport = page.viewportSize()!;
    await sampledDrag(
      page,
      s,
      "A7 auto-scroll",
      top,
      [{ x: top.x + 40, y: viewport.height - 4 }],
      1500,
    );

    r.eq(
      "A: no span and native selection were EVER visible together",
      s.both,
      [],
    );
    await page.context().close();
  }

  // ---- B. one colour, clearly a selection, both schemes ------------------
  for (const colorScheme of ["light", "dark"] as const) {
    const { page } = await h.session({
      colorScheme,
      viewport: { width: 1100, height: 700 },
    });
    await openBlankPage(page, { settleMs: 3000 });
    await typeLines(page, LINES);
    await page.waitForTimeout(2000);

    // Native: a double-clicked word in line 2.
    const w = await charRect(page, 1, 6, 11); // "three"
    await page.mouse.dblclick(w.x + w.width / 2, w.y + w.height / 2);
    await page.waitForTimeout(400);
    // The native selection brings the format toolbar, floating right above the
    // line — and its popover SHADOW (heavy in dark) falls across the word.
    // Shadows off for the sample, symmetrically for both kinds, so what is
    // compared is the selection fill alone.
    const noShadows = await page.addStyleTag({
      content: "* { box-shadow: none !important; }",
    });
    const nativeFill = await fillColour(page, w);
    const bg = await fillColour(page, {
      x: w.x + w.width + 300,
      y: w.y,
      width: 40,
      height: w.height,
    });
    await page.screenshot({
      path: `/tmp/span-native-${colorScheme}-native.png`,
    });

    await noShadows.evaluate((el) => el.parentNode?.removeChild(el));
    // Collapse the native selection first: its selection toolbar floats over
    // line 1, where the drag below starts.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(400);
    r.eq(
      `B ${colorScheme}: the native selection is collapsed before the span`,
      (await visibleSelections(page)).native,
      "",
    );

    // Painted: a span over all three lines; the same word is in its middle.
    const from = await pointAt(page, 0, 2);
    const to = await pointAt(page, 2, 8);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.move(from.x + 4, from.y, { steps: 3 });
    await page.mouse.move(to.x, to.y, { steps: 15 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const shown = await visibleSelections(page);
    r.ok(
      `B ${colorScheme}: the word is now inside a PAINTED span, with no native selection`,
      shown.painted.includes("three") && shown.native === "",
      JSON.stringify(shown),
    );
    const noShadows2 = await page.addStyleTag({
      content: "* { box-shadow: none !important; }",
    });
    const paintedFill = await fillColour(page, w);
    await noShadows2.evaluate((el) => el.parentNode?.removeChild(el));
    await page.screenshot({ path: `/tmp/span-native-${colorScheme}-span.png` });

    const fmt = (c: Rgba) => `rgb(${c.r},${c.g},${c.b})`;
    console.log(
      `${colorScheme}: native ${fmt(nativeFill)}  span ${fmt(paintedFill)}  background ${fmt(bg)}`,
    );
    r.ok(
      `B ${colorScheme}: the span's fill IS the native selection's fill`,
      colorDistance(nativeFill, paintedFill) <= 3,
      `native ${fmt(nativeFill)} vs span ${fmt(paintedFill)}`,
    );
    r.ok(
      `B ${colorScheme}: and it reads as a selection against the background`,
      colorDistance(paintedFill, bg) >= 50,
      `span ${fmt(paintedFill)} vs background ${fmt(bg)}`,
    );
    await page.context().close();
  }

  await r.finish();
});
