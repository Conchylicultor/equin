// Verifies the caret's TERMINAL landing — what a vertical arrow does when there
// is nothing beyond the block list to cross into.
//
//  A. ArrowDown on the LAST block, caret mid-text, lands at the END of that
//     block. It used to be swallowed entirely (`navigate` ran off the block
//     order, found no `caretAfter` chrome, and returned).
//  B. ArrowDown once the caret is already at that end changes nothing, and does
//     not throw the caret out of the block.
//  C. ArrowRight at the same position still does nothing: horizontal motion is
//     character-based, and there is no next character.
//  D. Regression guard for the other end — ArrowUp from the FIRST block still
//     leaves the block list for the page title (the Pages app DOES pass
//     `caretBefore`, so the terminal landing must not have stolen that hop).
//
// Usage: ./equin run plugins/page/plugins/editor/e2e/document-edge-caret-verify.ts
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { openBlankPage, editableBlocks } from "./support/blank-page";

const r = report();

interface Probe {
  /** The block the caret is in, or null when it left the block list. */
  block: string | null;
  /** Linear caret offset within the block's text. */
  offset: number;
  /** The block's whole text length — `offset === length` is "at the end". */
  length: number;
}

/**
 * Where the caret is, as (block, offset, block length).
 *
 * The offset is measured over the block's WHOLE text rather than over the
 * anchor's own text node, so "at the end" is one comparison regardless of how
 * many nodes Lexical happened to split the paragraph into.
 */
async function caretAt(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0)
      return { block: null, offset: -1, length: -1 };
    const anchor = sel.anchorNode;
    const el =
      anchor?.nodeType === 1 ? (anchor as Element) : anchor?.parentElement;
    const editable = el?.closest('[contenteditable="true"]');
    const blockEl = editable?.closest("[data-block-id]");
    if (!editable || !blockEl) return { block: null, offset: -1, length: -1 };
    const before = document.createRange();
    before.selectNodeContents(editable);
    before.setEnd(sel.anchorNode!, sel.anchorOffset);
    return {
      block: blockEl.getAttribute("data-block-id"),
      offset: before.toString().length,
      length: (editable.textContent ?? "").length,
    };
  });
}

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await openBlankPage(page, { settleMs: 3000, timeoutMs: 120_000 });

  await page.keyboard.type("alpha");
  await page.keyboard.press("Enter");
  await page.keyboard.type("bravo omega");
  await page.waitForTimeout(1500);

  r.ok("setup — two blocks", (await editableBlocks(page).count()) === 2);

  // Caret into the middle of the last block: five steps back off its end.
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(400);
  const mid = await caretAt(page);
  console.log("caret mid-last-block:", JSON.stringify(mid));
  r.ok(
    "setup — caret sits mid-text in the last block",
    mid.block !== null && mid.offset > 0 && mid.offset < mid.length,
    JSON.stringify(mid),
  );

  // ---- A ----
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(400);
  const landed = await caretAt(page);
  console.log("after ArrowDown:", JSON.stringify(landed));
  r.ok(
    "A: ArrowDown on the last block moves the caret to its END",
    landed.block === mid.block && landed.offset === landed.length,
    JSON.stringify(landed),
  );

  // ---- B ----
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(400);
  const again = await caretAt(page);
  console.log("after ArrowDown #2:", JSON.stringify(again));
  r.ok(
    "B: a second ArrowDown holds the caret at the end, still in the block",
    again.block === mid.block && again.offset === again.length,
    JSON.stringify(again),
  );

  // ---- C ----
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(400);
  const right = await caretAt(page);
  console.log("after ArrowRight:", JSON.stringify(right));
  r.ok(
    "C: ArrowRight at the very end still does nothing",
    right.block === mid.block && right.offset === right.length,
    JSON.stringify(right),
  );

  // ---- D ----
  await editableBlocks(page).first().click();
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(500);
  const up = await caretAt(page);
  const inTitle = await page.evaluate(
    () => document.activeElement?.tagName.toLowerCase() ?? null,
  );
  console.log(
    "after ArrowUp from block 1:",
    JSON.stringify(up),
    "focus:",
    inTitle,
  );
  r.ok(
    "D: ArrowUp from the first block still hands the caret to the page title",
    up.block === null && (inTitle === "input" || inTitle === "textarea"),
    `${JSON.stringify(up)} focus=${inTitle}`,
  );

  await context.close();

  console.log("\n=== SUMMARY ===");
  await r.finish();
});
