// Dormant lines: a page's text blocks are static text until an edit intent
// wakes one (research/2026-11-15-page-lazy-block-editors.md). Verifies, on a
// fresh page of 30 typed lines:
//
//  A. only a few lines hold a live editor; the rest are static and show the
//     text that was typed into them before they went dormant;
//  B. a click inside a dormant line lands the caret where it fell, and keys
//     typed at once (before its editor is on screen) land there, in order;
//  C. ArrowDown into a dormant line lands in it, and typing follows;
//  D. Backspace at the start of a line merges into the DORMANT line above,
//     and what is typed next lands at the join;
//  E. a line woken in place does not move: its box and first glyph keep their
//     position across the static → live swap (no flicker, no jump);
//  F. another writer's edit shows on a line that is dormant here.
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/dormant-lines-verify.ts [--out <dir>]
import type { Page } from "playwright";
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  BLOCK_TEXT_SELECTOR,
  blockTexts,
  openBlankPage,
} from "./support/blank-page";
import { typeLines } from "./support/type-lines";

const out = arg("out", "/tmp/dormant-lines");
const r = report();
const N = 30;
const lines = Array.from({ length: N }, (_, i) => `line ${i} words`);

/** The viewport point just left of character `offset` of line `index`. */
async function pointBefore(
  page: Page,
  index: number,
  offset: number,
): Promise<{ x: number; y: number }> {
  return page.evaluate(
    ({ index, offset, selector }) => {
      const root = document.querySelectorAll(selector)[index]!;
      root.scrollIntoView({ block: "center" });
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode() as Text;
      const range = document.createRange();
      range.setStart(text, offset);
      range.setEnd(text, offset + 1);
      const box = range.getBoundingClientRect();
      return { x: box.left + 1, y: box.top + box.height / 2 };
    },
    { index, offset, selector: BLOCK_TEXT_SELECTOR },
  );
}

const counts = (page: Page) =>
  page.evaluate(() => ({
    live: document.querySelectorAll('[data-block-id] [contenteditable="true"]')
      .length,
    dormant: document.querySelectorAll("[data-block-id] [data-static-text]")
      .length,
  }));

await withBrowser(async (h) => {
  const a = await h.session({ label: "A" });
  const page = a.page;
  await page.setViewportSize({ width: 1100, height: 900 });
  const doc = await openBlankPage(page, { settleMs: 1500 });
  await typeLines(page, lines);
  await page.waitForTimeout(2500);

  // A — most lines dormant, and their text is what was typed.
  const c = await counts(page);
  r.ok(
    "A: only a few lines are live",
    c.live <= 10 && c.dormant >= N - 10,
    JSON.stringify(c),
  );
  r.ok(
    "A: every line shows its typed text",
    JSON.stringify(await blockTexts(page)) === JSON.stringify(lines),
    JSON.stringify(await blockTexts(page)),
  );

  // E — geometry of a dormant line, before it wakes.
  const box = (i: number) =>
    page.evaluate(
      ({ i, selector }) => {
        const root = document.querySelectorAll(selector)[i]!;
        const row = root.closest("[data-block-id]")!.getBoundingClientRect();
        const range = document.createRange();
        const text = document
          .createTreeWalker(root, NodeFilter.SHOW_TEXT)
          .nextNode()!;
        range.setStart(text, 0);
        range.setEnd(text, 1);
        const g = range.getBoundingClientRect();
        return { rowTop: row.top, rowH: row.height, gx: g.left, gy: g.top };
      },
      { i, selector: BLOCK_TEXT_SELECTOR },
    );
  // (`pointBefore` scrolls the line into view: measure after it.)
  const p = await pointBefore(page, 5, 2);
  const before5 = await box(5);

  // B — click before "n" of "line 5 words" (offset 2), type at once.
  await page.mouse.click(p.x, p.y);
  await page.keyboard.type("XY");
  await page.waitForTimeout(800);
  let texts = await blockTexts(page);
  r.ok(
    "B: click in a dormant line types at the click",
    texts[5] === "liXYne 5 words",
    texts[5],
  );
  const after5 = await box(5);
  r.ok(
    "E: the woken line kept its box and its first glyph",
    Math.abs(after5.rowTop - before5.rowTop) < 0.5 &&
      Math.abs(after5.rowH - before5.rowH) < 0.5 &&
      Math.abs(after5.gx - before5.gx) < 0.5 &&
      Math.abs(after5.gy - before5.gy) < 0.5,
    `${JSON.stringify(before5)} -> ${JSON.stringify(after5)}`,
  );

  // C — ArrowDown into dormant line 6, type at once.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.type("Z");
  await page.waitForTimeout(800);
  texts = await blockTexts(page);
  r.ok(
    "C: ArrowDown into a dormant line, typing follows",
    texts[6]!.includes("Z") && texts[6]!.replace("Z", "") === "line 6 words",
    texts[6],
  );

  // D — Backspace at the start of line 12 merges into dormant line 11.
  const s = await pointBefore(page, 12, 0);
  await page.mouse.click(s.x, s.y);
  await page.waitForTimeout(600);
  const c11 = await counts(page);
  await page.keyboard.press("Backspace");
  await page.keyboard.type("Q");
  await page.waitForTimeout(1200);
  texts = await blockTexts(page);
  r.ok(
    "D: Backspace merges into the dormant line above, typing lands at the join",
    texts[11] === "line 11 wordsQline 12 words" && texts.length === N - 1,
    `${texts[11]} (${texts.length} lines; before merge ${JSON.stringify(c11)})`,
  );
  await snap(page, out, "1-edited");

  // F — another writer edits line 20, dormant here.
  const b = await h.session({ label: "B" });
  await b.page.setViewportSize({ width: 1100, height: 900 });
  await b.page.goto(doc.pageUrl, { waitUntil: "domcontentloaded" });
  await b.page.locator(BLOCK_TEXT_SELECTOR).nth(19).waitFor();
  await b.page.waitForTimeout(1500);
  const bp = await pointBefore(b.page, 19, 0);
  await b.page.mouse.click(bp.x, bp.y);
  await b.page.keyboard.type("REMOTE ");
  const isDormant = await page.evaluate(
    (selector) =>
      document.querySelectorAll(selector)[19]!.hasAttribute("data-static-text"),
    BLOCK_TEXT_SELECTOR,
  );
  let seen = "";
  for (let i = 0; i < 40 && !seen.startsWith("REMOTE"); i++) {
    await page.waitForTimeout(250);
    seen = (await blockTexts(page))[19] ?? "";
  }
  r.ok(
    "F: another writer's edit shows on a dormant line",
    isDormant && seen === "REMOTE line 20 words",
    `dormant=${isDormant} text=${seen}`,
  );

  const isStatic = (i: number) =>
    page.evaluate(
      ({ i, selector }) =>
        document
          .querySelectorAll(selector)
          [i]!.hasAttribute("data-static-text"),
      { i, selector: BLOCK_TEXT_SELECTOR },
    );
  const focusLive = async (where: string) => {
    try {
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute("contenteditable") === "true",
        undefined,
        { timeout: 10_000 },
      );
    } catch (err) {
      const active = await page.evaluate(() => {
        const el = document.activeElement;
        return `${el?.tagName}.${el?.className.toString().slice(0, 60)} in ${el?.closest("[data-block-id]")?.textContent ?? "-"}`;
      });
      throw new Error(`${where}: the caret never landed (focus on ${active})`, {
        cause: err,
      });
    }
  };

  // G — Delete at the end of a line pulls up the DORMANT line below it.
  // Just past the line's last glyph ("End" does not move a caret headless).
  const g = await pointBefore(page, 23, "line 24 words".length - 1);
  await page.mouse.click(g.x + 12, g.y);
  await focusLive("G");
  const belowDormant = await isStatic(24);
  await page.keyboard.press("Delete");
  await page.keyboard.type("D");
  await page.waitForTimeout(1200);
  texts = await blockTexts(page);
  r.ok(
    "G: Delete at the end pulls a dormant line up, typing stays at the join",
    belowDormant &&
      texts[23] === "line 24 wordsDline 25 words" &&
      texts.length === N - 2,
    `below dormant=${belowDormant} ${texts[23]} (${texts.length} lines)`,
  );

  // H — undo of a typing run in a line that has since gone dormant.
  const u = await pointBefore(page, 2, 0);
  await page.mouse.click(u.x, u.y);
  await focusLive("H click");
  await page.keyboard.type("UNDO ");
  await page.waitForTimeout(900);
  // Wake enough other lines that line 2 is evicted.
  for (let i = 8; i < 18; i++) {
    const w = await pointBefore(page, i, 0);
    await page.mouse.click(w.x, w.y);
    await page.waitForTimeout(120);
  }
  await focusLive("H after waking others");
  await page.waitForTimeout(600);
  const evicted = await isStatic(2);
  await page.keyboard.press("Meta+z");
  let undone = "";
  for (let i = 0; i < 20 && undone !== "line 2 words"; i++) {
    await page.waitForTimeout(250);
    undone = (await blockTexts(page))[2] ?? "";
  }
  r.ok(
    "H: undo reaches a typing run in a line that went dormant",
    evicted && undone === "line 2 words",
    `evicted=${evicted} text=${undone}`,
  );

  // I — a span dragged out of a dormant line stays painted once its start
  // line wakes (the span pins it): the painted Ranges follow the swap.
  await page.keyboard.press("Escape");
  await page.mouse.click(1090, 880);
  const d0 = await pointBefore(page, 20, 2);
  const d1 = await pointBefore(page, 22, 4);
  const startDormant = await isStatic(20);
  await page.mouse.move(d0.x, d0.y);
  await page.mouse.down();
  await page.mouse.move(d0.x, d0.y + 30, { steps: 4 });
  await page.mouse.move(d1.x, d1.y, { steps: 6 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  const paint = await page.evaluate(() => {
    const hl = (
      CSS as unknown as {
        highlights?: Map<string, Iterable<Range>>;
      }
    ).highlights?.get("page-text-span");
    const ranges = hl ? [...hl] : [];
    return ranges.map((r) => ({
      text: r.toString(),
      connected: r.startContainer.isConnected,
    }));
  });
  r.ok(
    "I: a span from a dormant line stays painted after the line wakes",
    startDormant &&
      paint.length === 3 &&
      paint.every((p) => p.connected && p.text.length > 0) &&
      paint[0]!.text === "ne 21 words",
    `start dormant=${startDormant} ${JSON.stringify(paint)}`,
  );

  const end = await counts(page);
  r.ok(
    "A: still only a few live lines after editing",
    end.live <= 10,
    JSON.stringify(end),
  );
  await r.finish();
});
