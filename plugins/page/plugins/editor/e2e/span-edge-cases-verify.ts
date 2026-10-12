// Text-selection edge cases a user meets at typing speed, verified in a real
// browser: what Enter, typing and Cmd+Z do with a selection — a native one
// inside one block (double / triple click) and an editor-owned span across
// blocks. Every scenario runs on a fresh page and settles only where a user
// would naturally pause, so an undo entry split in two (or a key lost between
// the span's delete and the caret's landing) shows up as a wrong text.
//
// Asserts:
//   A. double-click a word, Enter: the word is gone and the line splits there;
//      ONE Cmd+Z restores the line;
//   B. triple-click a line, Enter: its text is gone, an empty line follows;
//      ONE Cmd+Z restores it;
//   C. a span across three lines, Enter: head1 | tail3 on two lines; ONE Cmd+Z
//      restores the three lines;
//   D. a span, then "xyz" typed back-to-back: head1 + xyz + tail3, nothing lost;
//   E. a span, Delete, Cmd+Z with NO pause: the three lines are back;
//   F. a double-click selection, typed over: the word is replaced.
//
// Usage: ./singularity run plugins/page/plugins/editor/e2e/span-edge-cases-verify.ts [--url <deploy>]
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import {
  blockTexts,
  editableBlocks,
  openBlankPage,
} from "./support/blank-page";
import { typeLines } from "./support/type-lines";

const LINES = ["alpha one two", "bravo three four", "charlie five six"];
const FROM = 6;
const TO = 8;
const head1 = LINES[0]!.slice(0, FROM);
const tail3 = LINES[2]!.slice(TO);

const r = report();

/** The viewport point just inside character `index` of block `blockIndex`. */
async function pointAt(
  page: Page,
  blockIndex: number,
  index: number,
): Promise<{ x: number; y: number }> {
  const box = await editableBlocks(page)
    .nth(blockIndex)
    .evaluate((el, i) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      if (!text) throw new Error("block has no text node");
      const range = document.createRange();
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, y: rect.top + rect.height / 2 };
    }, index);
  return { x: box.x + 1, y: box.y };
}

async function drag(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.move(from.x + 4, from.y, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

async function freshPage(page: Page): Promise<void> {
  await openBlankPage(page, { settleMs: 2000 });
  await typeLines(page, LINES);
  await page.waitForTimeout(1500);
  r.eq("setup: three lines", await blockTexts(page), LINES);
}

/** Cmd+Z once, after the pause a user takes before reaching for it. */
async function undoOnce(page: Page): Promise<string[]> {
  await page.waitForTimeout(700);
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(2000);
  return blockTexts(page);
}

await withBrowser(async (h) => {
  const { page } = await h.session();

  // A. Double-click a word, Enter.
  await freshPage(page);
  const one = await pointAt(page, 0, 7);
  await page.mouse.dblclick(one.x, one.y);
  await page.waitForTimeout(300);
  r.eq(
    "A: double-click selects the word",
    await page.evaluate(() => window.getSelection()?.toString().trim()),
    "one",
  );
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  r.eq("A: Enter replaces the word with a line break", await blockTexts(page), [
    "alpha",
    "two",
    LINES[1]!,
    LINES[2]!,
  ]);
  r.eq("A: ONE Cmd+Z restores the line", await undoOnce(page), LINES);

  // B. Triple-click a line, Enter.
  await freshPage(page);
  const bravo = await pointAt(page, 1, 3);
  await page.mouse.click(bravo.x, bravo.y, { clickCount: 3 });
  await page.waitForTimeout(300);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  r.eq("B: Enter replaces the line's text", await blockTexts(page), [
    LINES[0]!,
    "",
    "",
    LINES[2]!,
  ]);
  r.eq("B: ONE Cmd+Z restores it", await undoOnce(page), LINES);

  // C. A span, Enter.
  await freshPage(page);
  await drag(page, await pointAt(page, 0, FROM), await pointAt(page, 2, TO));
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1500);
  r.eq("C: Enter over a span splits at the join", await blockTexts(page), [
    head1.trim(),
    tail3.trim(),
  ]);
  r.eq("C: ONE Cmd+Z restores the three lines", await undoOnce(page), LINES);

  // D. A span, typed over back-to-back.
  await freshPage(page);
  await drag(page, await pointAt(page, 0, FROM), await pointAt(page, 2, TO));
  await page.keyboard.type("xyz");
  await page.waitForTimeout(1500);
  r.eq("D: every typed key lands", await blockTexts(page), [
    `${head1}xyz${tail3}`,
  ]);

  // E. A span, Delete, Cmd+Z at once.
  await freshPage(page);
  await drag(page, await pointAt(page, 0, FROM), await pointAt(page, 2, TO));
  await page.keyboard.press("Delete");
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(2500);
  r.eq(
    "E: an immediate Cmd+Z restores the lines",
    await blockTexts(page),
    LINES,
  );

  // F. Double-click, typed over.
  await freshPage(page);
  const three = await pointAt(page, 1, 8);
  await page.mouse.dblclick(three.x, three.y);
  await page.waitForTimeout(300);
  await page.keyboard.type("Z");
  await page.waitForTimeout(1500);
  r.eq("F: typing replaces the double-clicked word", await blockTexts(page), [
    LINES[0]!,
    "bravo Z four",
    LINES[2]!,
  ]);

  await r.finish();
});
