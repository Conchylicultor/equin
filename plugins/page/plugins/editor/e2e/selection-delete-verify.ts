// Deleting a selection INSIDE one block with ONE Backspace / Delete press, in a
// real browser — for every way a user selects text there. Each scenario checks
// what the user sees: the text is gone at once (no second press), ONE Cmd+Z
// brings it back and redo removes it again (it is on the undo stack), and it
// stays gone after a reload (it reached the content doc).
//
// The native-selection scenarios are the regression net for
// `text-editor/no-flushing-editor-read`: the key command's caret read used to
// call `editor.read()`, whose flush committed the keystroke's update before
// Lexical's delete ran — the text stayed on screen, vanished on the next click,
// came back on reload, and Cmd+Z had nothing to restore. The off-row drag is an
// editor-owned span (a different path), kept as the control.
//
// Usage: ./singularity run plugins/page/plugins/editor/e2e/selection-delete-verify.ts [--url <deploy>]
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

const r = report();

async function pointAt(
  page: Page,
  blockIndex: number,
  index: number,
): Promise<{ x: number; y: number }> {
  return editableBlocks(page)
    .nth(blockIndex)
    .evaluate((el, i) => {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      if (!text) throw new Error("block has no text node");
      const range = document.createRange();
      range.setStart(text, i);
      range.setEnd(text, i + 1);
      const rect = range.getBoundingClientRect();
      return { x: rect.left + 1, y: rect.top + rect.height / 2 };
    }, index);
}

async function freshPage(page: Page): Promise<void> {
  await openBlankPage(page, { settleMs: 2000 });
  await typeLines(page, LINES);
  await page.waitForTimeout(1500);
  r.eq("setup: three lines", await blockTexts(page), LINES);
}

interface Scenario {
  name: string;
  key: "Backspace" | "Delete";
  select: (page: Page) => Promise<void>;
  expected: string[];
}

const SCENARIOS: Scenario[] = [
  {
    name: "double-click a word",
    key: "Backspace",
    select: async (page) => {
      const p = await pointAt(page, 1, 8);
      await page.mouse.dblclick(p.x, p.y);
    },
    expected: [LINES[0]!, "bravo  four", LINES[2]!],
  },
  {
    name: "Shift+End from mid-line",
    key: "Delete",
    select: async (page) => {
      const p = await pointAt(page, 1, 6);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(200);
      await page.keyboard.press("Shift+End");
    },
    expected: [LINES[0]!, "bravo", LINES[2]!],
  },
  {
    name: "drag inside the line",
    key: "Backspace",
    select: async (page) => {
      const from = await pointAt(page, 1, 6);
      const to = await pointAt(page, 1, 12);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();
    },
    expected: [LINES[0]!, "bravo four", LINES[2]!],
  },
  {
    name: "drag that strays off the row and back",
    key: "Backspace",
    select: async (page) => {
      const from = await pointAt(page, 1, 6);
      const to = await pointAt(page, 1, 12);
      await page.mouse.move(from.x, from.y);
      await page.mouse.down();
      await page.mouse.move(to.x, to.y - 30, { steps: 10 });
      await page.mouse.move(to.x, to.y, { steps: 10 });
      await page.mouse.up();
    },
    expected: [LINES[0]!, "bravo four", LINES[2]!],
  },
];

await withBrowser(async (h) => {
  const { page } = await h.session();
  for (const s of SCENARIOS) {
    await freshPage(page);
    await s.select(page);
    await page.waitForTimeout(400);
    await page.keyboard.press(s.key);
    await page.waitForTimeout(500);
    r.eq(
      `${s.name}: ONE ${s.key} deletes it`,
      await blockTexts(page),
      s.expected,
    );
    await page.waitForTimeout(700);
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(1500);
    r.eq(`${s.name}: ONE Cmd+Z restores it`, await blockTexts(page), LINES);
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await page.waitForTimeout(1500);
    r.eq(
      `${s.name}: redo deletes it again`,
      await blockTexts(page),
      s.expected,
    );
    // Past the doc flush and the ~1s row projection, then from the server.
    await page.waitForTimeout(2500);
    await page.goto(page.url(), { waitUntil: "domcontentloaded" });
    await editableBlocks(page).first().waitFor({ state: "visible" });
    await page.waitForTimeout(2500);
    r.eq(
      `${s.name}: still deleted after reload`,
      await blockTexts(page),
      s.expected,
    );
  }
  await r.finish();
});
