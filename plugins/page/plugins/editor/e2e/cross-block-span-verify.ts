// Partial cross-block text selection, verified in a real browser.
//
// A text drag that leaves its origin row becomes an EDITOR-OWNED span with
// partial ends (research/2026-10-09-page-cross-block-text-selection.md): it is
// painted through the CSS Custom Highlight API (`page-text-span`), never as a
// native selection, and Delete removes exactly the span as ONE `deleteSpan` op —
// the start line keeps its head and takes the end line's tail.
//
// Asserts, on three typed lines:
//   1. drag mid-line-1 → mid-line-3 paints [tail1, line2, head3], holds NO native
//      selection, and selects no block;
//   2. Delete leaves ONE block reading head1 + tail3;
//   3. Cmd+Z restores all three blocks with their text, Cmd+Shift+Z redoes;
//   4. a drag that crosses out of its origin and comes BACK keeps a partial span
//      inside the origin (the retired one-way promotion would select it whole);
//   5. typing `x` over a span leaves head1 + "x" + tail3, and ONE Cmd+Z undoes it;
//   6. Cmd+C puts the span's partial markdown on the clipboard (tail1, line2,
//      head3) — and pasting it at the end of line 2 SPLICES (its first line
//      merges into the caret's line), one undo step;
//   7. Cmd+X copies the span AND deletes it (head1 + tail3);
//   8. Cmd+V over a span replaces it with the clipboard, one undo step;
//   9. Shift+ArrowDown from mid-line-1 draws a span into line 2 at the caret's
//      column (no native selection), and Delete merges the two lines;
//  10. Shift+ArrowRight at a line's end crosses into the next line one character
//      at a time, and stepping back onto the anchor is a caret again;
//  11. a NESTED partial copy pasted mid-line joins at both ends, nesting kept.
//
// Usage: ./singularity run plugins/page/plugins/editor/e2e/cross-block-span-verify.ts [--url <deploy>]
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
import { blockSelectionDriver } from "./support/block-selection";
import { typeLines } from "./support/type-lines";

const LINES = ["alpha one two", "bravo three four", "charlie five six"];
/** Where the drag starts in line 1 (before "one") and ends in line 3 (before "five"). */
const FROM = 6;
const TO = 8;

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

/** The painted span, one string per highlighted Range, in paint order. */
function paintedSpan(page: Page): Promise<string[] | null> {
  return page.evaluate(() => {
    const h = CSS.highlights.get("page-text-span");
    return h ? [...h].map((range) => range.toString()) : null;
  });
}

/** The native selection's text ("" when there is none or it is collapsed). */
function nativeSelection(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

/**
 * Press inside `from`, hold past the editor's async post-click focus steal
 * (see `support/block-selection.ts`), then drag through `via` to `to`.
 */
async function drag(
  page: Page,
  from: { x: number; y: number },
  ...path: { x: number; y: number }[]
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.move(from.x + 4, from.y, { steps: 3 });
  for (const p of path) await page.mouse.move(p.x, p.y, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/** The clipboard's text/plain, line by line, each line's trailing space dropped. */
async function clipboardLines(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => navigator.clipboard.readText());
  return text.split("\n").map((line) => line.trimEnd());
}

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openBlankPage(page, { settleMs: 3000 });
  await typeLines(page, LINES);
  await page.waitForTimeout(2000);
  r.eq("setup: three lines", await blockTexts(page), LINES);
  const { selectedCount } = blockSelectionDriver(page, r);

  // 1. The span.
  await drag(page, await pointAt(page, 0, FROM), await pointAt(page, 2, TO));
  r.eq("the span is painted, partial at both ends", await paintedSpan(page), [
    LINES[0]!.slice(FROM),
    LINES[1],
    LINES[2]!.slice(0, TO),
  ]);
  r.eq("no native selection exists", await nativeSelection(page), "");
  r.eq("no block is selected", await selectedCount(), 0);

  // 2. Delete joins head1 + tail3.
  await page.keyboard.press("Delete");
  await page.waitForTimeout(1500);
  const joined = LINES[0]!.slice(0, FROM) + LINES[2]!.slice(TO);
  r.eq("Delete leaves head1 + tail3 in one block", await blockTexts(page), [
    joined.trim(),
  ]);
  r.eq("the highlight is gone", await paintedSpan(page), null);

  // 3. One undo entry, both ways.
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(2500);
  r.eq("Cmd+Z restores all three lines", await blockTexts(page), LINES);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.waitForTimeout(2500);
  r.eq("Cmd+Shift+Z redoes the delete", await blockTexts(page), [
    joined.trim(),
  ]);
  await page.keyboard.press("ControlOrMeta+z");
  await page.waitForTimeout(2500);
  r.eq("Cmd+Z again restores the lines", await blockTexts(page), LINES);

  // 4. Out of the origin and back: a partial span inside line 1.
  await drag(
    page,
    await pointAt(page, 0, 2),
    await pointAt(page, 1, 4),
    await pointAt(page, 0, 9),
  );
  r.eq("dragging back keeps a PARTIAL span", await paintedSpan(page), [
    LINES[0]!.slice(2, 9),
  ]);
  r.eq("…and selects no block whole", await selectedCount(), 0);
  r.eq("…with no native selection", await nativeSelection(page), "");

  // Escape climbs to the touched block, whole; a second one clears it.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  r.eq("Escape turns the span into its blocks", await selectedCount(), 1);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  const span13 = async () =>
    drag(page, await pointAt(page, 0, FROM), await pointAt(page, 2, TO));
  const undo = async (label: string, expected: string[]) => {
    await page.keyboard.press("ControlOrMeta+z");
    await page.waitForTimeout(2500);
    r.eq(label, await blockTexts(page), expected);
  };
  const head1 = LINES[0]!.slice(0, FROM);
  const tail1 = LINES[0]!.slice(FROM);
  const head3 = LINES[2]!.slice(0, TO);
  const tail3 = LINES[2]!.slice(TO);

  // 5. Type over a span.
  await span13();
  await page.keyboard.type("x");
  await page.waitForTimeout(1500);
  r.eq(
    "5: typing x replaces the span: head1 + x + tail3",
    await blockTexts(page),
    [`${head1}x${tail3}`],
  );
  await undo("5: ONE Cmd+Z restores all three lines", LINES);

  // 6. Copy: the partial markdown; then paste it into another line.
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await span13();
  await page.keyboard.press("ControlOrMeta+c");
  await page.waitForTimeout(300);
  r.eq(
    "6: Cmd+C writes the span's partial markdown",
    await clipboardLines(page),
    [tail1, LINES[1]!, head3.trimEnd()],
  );
  r.eq("6: …and copying deletes nothing", await blockTexts(page), LINES);
  const endOf2 = await pointAt(page, 1, LINES[1]!.length - 1);
  await page.mouse.click(endOf2.x + 12, endOf2.y);
  await page.keyboard.press("End");
  await page.waitForTimeout(300);
  await page.keyboard.press("ControlOrMeta+v");
  await page.waitForTimeout(2000);
  r.eq("6: pasting it SPLICES at the caret", await blockTexts(page), [
    LINES[0]!,
    `${LINES[1]}${tail1}`,
    LINES[1]!,
    head3.trim(),
    LINES[2]!,
  ]);
  await undo("6: one Cmd+Z removes the whole paste", LINES);

  // 7. Cut.
  await span13();
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await page.keyboard.press("ControlOrMeta+x");
  await page.waitForTimeout(1500);
  r.eq("7: Cmd+X deletes the span", await blockTexts(page), [
    (head1 + tail3).trim(),
  ]);
  r.eq("7: …having copied it", await clipboardLines(page), [
    tail1,
    LINES[1]!,
    head3.trimEnd(),
  ]);
  await undo("7: one Cmd+Z restores the lines", LINES);

  // 8. Paste OVER a span: line 1 from "one", to line 2 before "three".
  const TO2 = 6;
  await drag(page, await pointAt(page, 0, FROM), await pointAt(page, 1, TO2));
  await page.keyboard.press("ControlOrMeta+v");
  await page.waitForTimeout(2000);
  r.eq(
    "8: Cmd+V replaces the span with the clipboard",
    await blockTexts(page),
    [LINES[0]!, LINES[1]!, `${head3}${LINES[1]!.slice(TO2)}`, LINES[2]!],
  );
  await undo("8: one Cmd+Z restores the lines", LINES);

  // 9. Shift+ArrowDown from mid-line-1 into line 2.
  const mid1 = await pointAt(page, 0, FROM);
  await page.mouse.click(mid1.x, mid1.y);
  await page.waitForTimeout(400);
  await page.keyboard.press("Shift+ArrowDown");
  await page.waitForTimeout(400);
  const painted = (await paintedSpan(page)) ?? [];
  r.eq("9: Shift+ArrowDown draws a span over two lines", painted.length, 2);
  r.eq("9: …starting at the caret", painted[0], tail1);
  r.ok(
    "9: …ending in line 2 near the caret's column",
    painted[1] !== undefined &&
      painted[1].length >= FROM - 2 &&
      painted[1].length <= FROM + 2 &&
      LINES[1]!.startsWith(painted[1]),
  );
  r.eq("9: no native selection", await nativeSelection(page), "");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(1500);
  r.eq("9: Delete merges the two lines", await blockTexts(page), [
    `${head1}${LINES[1]!.slice((painted[1] ?? "").length)}`.trim(),
    LINES[2]!,
  ]);
  await undo("9: one Cmd+Z restores the lines", LINES);

  // 10. Shift+ArrowRight across a line's end, and back.
  const end1 = await pointAt(page, 0, LINES[0]!.length - 1);
  await page.mouse.click(end1.x + 12, end1.y);
  await page.keyboard.press("End");
  await page.waitForTimeout(300);
  await page.keyboard.press("Shift+ArrowRight");
  await page.keyboard.press("Shift+ArrowRight");
  await page.waitForTimeout(300);
  r.eq("10: two Shift+ArrowRight cross into line 2", await paintedSpan(page), [
    LINES[1]!.slice(0, 1),
  ]);
  await page.keyboard.press("Shift+ArrowLeft");
  await page.keyboard.press("Shift+ArrowLeft");
  await page.waitForTimeout(400);
  r.eq("10: back onto the anchor: no span", await paintedSpan(page), null);
  r.eq(
    "10: …but a caret in line 1 again",
    await page.evaluate(() => {
      const sel = window.getSelection();
      const block = document.querySelectorAll(
        '[data-block-id] [contenteditable="true"]',
      )[0];
      return !!sel && sel.isCollapsed && !!block?.contains(sel.anchorNode);
    }),
    true,
  );
  await page.keyboard.type("!");
  await page.waitForTimeout(1500);
  r.eq("10: …which types at the end of line 1", await blockTexts(page), [
    `${LINES[0]}!`,
    LINES[1]!,
    LINES[2]!,
  ]);

  // 11. A NESTED partial copy pasted mid-line joins at BOTH ends:
  //     copy `aa[aa` › `bb]bb`, paste at `zz|zz` → `zzaa` › `bbzz`.
  const end3 = await pointAt(page, 2, LINES[2]!.length - 1);
  await page.mouse.click(end3.x + 12, end3.y);
  await page.keyboard.press("End");
  await typeLines(
    page,
    ["aaaa", { text: "bbbb", indent: "in" }, { text: "zzzz", indent: "out" }],
    { leadingEnter: true },
  );
  await page.waitForTimeout(2000);
  const before11 = [
    `${LINES[0]}!`,
    LINES[1]!,
    LINES[2]!,
    "aaaa",
    "bbbb",
    "zzzz",
  ];
  r.eq("11: setup", await blockTexts(page), before11);
  const textLeft = (i: number) =>
    editableBlocks(page)
      .nth(i)
      .evaluate((el) => el.getBoundingClientRect().left);
  r.ok("11: setup: bbbb is nested", (await textLeft(4)) > (await textLeft(3)));
  await drag(page, await pointAt(page, 3, 2), await pointAt(page, 4, 2));
  await page.keyboard.press("ControlOrMeta+c");
  await page.waitForTimeout(300);
  const zz = await pointAt(page, 5, 2);
  await page.mouse.click(zz.x, zz.y);
  await page.waitForTimeout(400);
  await page.keyboard.press("ControlOrMeta+v");
  await page.waitForTimeout(2000);
  r.eq(
    "11: the first fragment joins the head, the last the tail",
    await blockTexts(page),
    [...before11.slice(0, 5), "zzaa", "bbzz"],
  );
  r.ok(
    "11: …and the last line keeps its nesting under the joined line",
    (await textLeft(6)) > (await textLeft(5)),
  );
  await undo("11: one Cmd+Z restores the line", before11);

  await r.finish();
});
