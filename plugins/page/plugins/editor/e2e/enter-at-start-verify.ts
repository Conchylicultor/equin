// Enter-at-start identity-preservation verification
// (research/2026-07-22-page-enter-at-start-identity-preservation.md).
//
// Pressing Enter at the very start of a NON-EMPTY block must PRESERVE the origin
// block's identity: insert a new EMPTY sibling ABOVE and leave the origin block
// itself (its id, text, content doc) untouched, caret staying in the origin.
//
//  1. blank page; type "hello world" into the first block; capture its block id
//     (originId) and let the ~1s doc→data.text projection land;
//  2. caret to offset 0, press Enter;
//  3. assert: TWO blocks; the block still carrying originId holds "hello world";
//     a NEW EMPTY block sits ABOVE it in DOM order; the origin id is unchanged;
//  4. assert the caret is collapsed in originId at offset 0;
//  5. type a char → it lands in originId (the content doc followed the id, never
//     churned to a fresh block);
//  6. Cmd+Z (undo the typing), Cmd+Z (undo the split) → the empty block above
//     disappears in one undo, one block left under originId, text intact;
//  7. converge in a SECOND browser context (fresh socket, cold load).
//
// Usage: bun plugins/page/plugins/editor/e2e/enter-at-start-verify.ts [--url <deploy>] [--out /tmp/eas]
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { blockText, caretState, openBlankPage } from "./support/blank-page";

const out = arg("out", "/tmp/eas");

const r = report();

/** Ordered list of every text-block id in document order. */
async function blockIdsInOrder(page: Page): Promise<(string | null)[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-block-id]")]
      .filter((el) => el.querySelector("[data-block-text]"))
      .map((el) => el.getAttribute("data-block-id")),
  );
}

interface PreEnterCaret {
  anchorText: string | null;
  anchorOffset: number;
}

await withBrowser(async (h) => {
  const { page: pageA } = await h.session({ label: "A" });

  const {
    pageUrl,
    block,
    blockId: originId,
  } = await openBlankPage(pageA, {
    settleMs: 3000,
  });
  console.log("page url:", pageUrl);
  console.log("origin id:", originId);

  // --- 1. compose a non-empty block -------------------------------------------
  await pageA.keyboard.type("hello world", { delay: 15 });
  // Let the doc flush (300ms) + projection (1s) land.
  await pageA.waitForTimeout(2500);
  await snap(pageA, out, "1-composed");
  const composedText = await blockText(block);
  r.ok(
    "compose: origin holds 'hello world'",
    composedText === "hello world",
    composedText,
  );

  // --- 2. Enter at the very start ---------------------------------------------
  // Home / Cmd+ArrowLeft don't move the caret in headless Chromium on macOS —
  // click at the text's left edge instead (nearest position = offset 0).
  await block.click({ position: { x: 2, y: 12 } });
  await pageA.waitForTimeout(300);
  const preEnterCaret = await pageA.evaluate<PreEnterCaret | null>(() => {
    const sel = window.getSelection();
    return sel && sel.rangeCount > 0
      ? {
          anchorText: sel.anchorNode?.textContent ?? null,
          anchorOffset: sel.anchorOffset,
        }
      : null;
  });
  console.log("pre-Enter caret:", JSON.stringify(preEnterCaret));
  await pageA.keyboard.press("Enter");
  await pageA.waitForTimeout(1500);
  await snap(pageA, out, "2-entered");

  const idsAfter = await blockIdsInOrder(pageA);
  console.log("ids after Enter:", JSON.stringify(idsAfter));
  r.ok(
    "enter: two text blocks",
    idsAfter.length === 2,
    `count=${idsAfter.length}`,
  );
  r.ok(
    "enter: origin id still present (no id churn)",
    idsAfter.includes(originId),
  );

  // The origin keeps its full text under its ORIGINAL id.
  const origin = pageA
    .locator(`[data-block-id="${originId}"] [data-block-text]`)
    .first();
  const originText = await blockText(origin);
  r.ok(
    "enter: origin still holds 'hello world'",
    originText === "hello world",
    originText,
  );

  // A NEW EMPTY block sits ABOVE the origin in document order.
  const originIdx = idsAfter.indexOf(originId);
  const aboveId = originIdx > 0 ? (idsAfter[originIdx - 1] ?? null) : null;
  r.ok(
    "enter: a new block sits ABOVE the origin",
    aboveId != null && aboveId !== originId,
    `above=${aboveId}`,
  );
  if (aboveId) {
    const above = pageA
      .locator(`[data-block-id="${aboveId}"] [data-block-text]`)
      .first();
    const aboveText = await blockText(above);
    r.ok(
      "enter: the block above is EMPTY",
      aboveText === "",
      JSON.stringify(aboveText),
    );
  }

  // Caret stays in the ORIGIN at offset 0 (it never lost focus).
  const enterCaret = await caretState(origin);
  console.log("enter caret:", JSON.stringify(enterCaret));
  r.ok(
    "enter: caret stays in the ORIGIN at offset 0",
    enterCaret.hasSelection === true &&
      enterCaret.collapsed === true &&
      enterCaret.insideBlock === true &&
      enterCaret.anchorOffset === 0,
  );

  // --- 3. type a char → it lands in the ORIGIN (content doc followed the id) ----
  await pageA.keyboard.type("Z", { delay: 15 });
  await pageA.waitForTimeout(800);
  const typedText = await blockText(origin);
  r.ok(
    "type: char lands at the start of the ORIGIN block",
    typedText === "Zhello world",
    typedText,
  );
  const idsAfterType = await blockIdsInOrder(pageA);
  r.ok(
    "type: origin id unchanged after typing",
    idsAfterType.includes(originId),
  );

  // --- 4. Undo the typing, then undo the split --------------------------------
  await pageA.keyboard.press("Meta+z"); // undo the "Z"
  await pageA.waitForTimeout(1000);
  const afterUndoType = await blockText(origin);
  r.ok(
    "undo: typing reverted, origin back to 'hello world'",
    afterUndoType === "hello world",
    afterUndoType,
  );

  await pageA.keyboard.press("Meta+z"); // undo the split (empty block above)
  await pageA.waitForTimeout(1200);
  await snap(pageA, out, "3-undone");
  const idsAfterUndo = await blockIdsInOrder(pageA);
  console.log("ids after undo:", JSON.stringify(idsAfterUndo));
  r.ok(
    "undo: empty block removed in one undo",
    idsAfterUndo.length === 1,
    `count=${idsAfterUndo.length}`,
  );
  r.ok(
    "undo: the surviving block is the ORIGIN",
    idsAfterUndo[0] === originId,
    `id=${idsAfterUndo[0]}`,
  );
  const afterUndoText = await blockText(origin);
  r.ok(
    "undo: origin text intact",
    afterUndoText === "hello world",
    afterUndoText,
  );

  // Let projections settle before the convergence read.
  await pageA.waitForTimeout(2000);

  // --- 5. Convergence in a second context --------------------------------------
  const { page: pageB } = await h.session({ label: "B" });
  await pageB.goto(pageUrl);
  await pageB.waitForTimeout(5000);
  const originB = pageB
    .locator(`[data-block-id="${originId}"] [data-block-text]`)
    .first();
  await originB.waitFor({ state: "visible", timeout: 15000 });
  const textB = await blockText(originB);
  const countB = (await blockIdsInOrder(pageB)).length;
  await snap(pageB, out, "4-context-b");
  console.log("context B text:", JSON.stringify(textB), "count:", countB);
  r.ok(
    "converge: context B matches (origin id + text)",
    textB === "hello world" && countB === 1,
    `count=${countB}`,
  );

  console.log("ORIGIN_ID:", originId);
  console.log("PAGE_URL:", pageUrl);

  await r.finish();
});
