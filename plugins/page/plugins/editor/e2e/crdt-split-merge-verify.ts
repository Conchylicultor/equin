// Stage-3a per-block CRDT verification (research/2026-07-07-page-per-block-crdt-plan-b.md).
//
// With per-block CRDT text (now unconditional — the flag is deleted):
//  1. create a blank page; type a mixed block: plain + BOLD run + a real
//     `[[` page-link token + a real `@` inline-date token + plain tail;
//  2. wait for the doc→data.text projection (~1s debounce) — the DB row is
//     checked by the caller via query_db using the printed block id;
//  3. SPLIT mid-bold-word (caret inside "boldy" after "bol") → head keeps
//     "alpha bol" with bold intact, the tail block gets "dy tail … end" with
//     the token decorators intact;
//  4. MERGE the tail back with Backspace-at-start → concatenated text + marks
//     restored, caret collapsed at the join;
//  5. converge in a SECOND browser context (fresh socket, cold load).
//
// Usage: bun plugins/page/plugins/editor/e2e/crdt-split-merge-verify.ts [--url <deploy>] [--out /tmp/sm]
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  ELEMENT_TIMEOUT_MS,
  waitFor,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/plugins/page-ready/core";
import { blockText, openBlankPage } from "./support/blank-page";
import { caretLinear, pressUntilOffset } from "./support/caret";

const out = arg("out", "/tmp/sm");
const r = report();

/** Caret probe after the split — a union so `has` gates the rest. */
type SplitCaret =
  | { has: false }
  | { has: true; collapsed: boolean; inTail: boolean; anchorOffset: number };

/** Caret probe after the merge. */
type MergeCaret =
  | { has: false }
  | {
      has: true;
      collapsed: boolean;
      inHead: boolean;
      anchorText: string | null;
      anchorOffset: number;
    };

await withBrowser(async (h) => {
  const { page: pageA } = await h.session({ label: "A" });

  const doc = await openBlankPage(pageA, { settleMs: 3000 });
  const pageUrl = doc.pageUrl;
  console.log("page url:", pageUrl);

  const block = doc.block;
  const block1Id = doc.blockId;
  console.log("block1 id:", block1Id);

  // --- 1. compose the mixed block ---------------------------------------------
  await pageA.keyboard.type("alpha ", { delay: 15 });
  await pageA.keyboard.press("Control+b");
  await pageA.keyboard.type("boldy", { delay: 15 });
  await pageA.keyboard.press("Control+b");
  await pageA.keyboard.type(" tail ", { delay: 15 });
  // Real page-link token via the [[ typeahead (Enter selects the active option).
  await pageA.keyboard.type("[[", { delay: 30 });
  await pageA.waitForTimeout(1200);
  await pageA.keyboard.press("Enter");
  await pageA.waitForTimeout(500);
  // Real inline-date token via the @ typeahead (Enter selects "Today").
  await pageA.keyboard.type(" @", { delay: 30 });
  await pageA.waitForTimeout(1200);
  await pageA.keyboard.press("Enter");
  await pageA.waitForTimeout(500);
  await pageA.keyboard.type(" omega end", { delay: 15 });

  // Let the doc flush (300ms) + projection (1s) land.
  await pageA.waitForTimeout(2500);
  await snap(pageA, out, "1-composed");

  const composedText = await blockText(block);
  console.log("composed block1 text:", JSON.stringify(composedText));
  const composedBold = await block.evaluate((el) =>
    [...el.querySelectorAll("strong, .font-bold")]
      .map((n) => n.textContent)
      .join("|"),
  );
  r.ok(
    "compose: bold run present",
    composedBold.includes("boldy"),
    `bold nodes: ${composedBold}`,
  );
  const composedTokens = await block.evaluate((el) => ({
    // decorator chips render as non-text inline elements; count anything the two
    // token plugins render (page-link + date chips both carry a data-lexical-decorator wrapper)
    decorators: el.querySelectorAll("[data-lexical-decorator]").length,
  }));
  r.ok(
    "compose: 2 decorator tokens",
    composedTokens.decorators >= 2,
    `found ${composedTokens.decorators}`,
  );

  // --- 2. SPLIT mid-bold-word ---------------------------------------------------
  // Caret to the very start, then WALK to linear offset 9 = after "alpha bol"
  // (inside boldy). Not a press count: the `alpha `|`boldy` seam is a mark
  // boundary, so one press there arms the pending mark and moves nothing — nine
  // presses advance eight positions (see `support/caret.ts`).
  // NOTE: Home / Cmd+ArrowLeft don't move the caret in headless Chromium on
  // macOS — click at the text's left edge instead (nearest position = offset 0).
  await block.click({ position: { x: 2, y: 12 } });
  await pageA.waitForTimeout(300);
  await pressUntilOffset(pageA, 9);
  r.eq(
    "fixture: the caret is at offset 9 before the split",
    await caretLinear(pageA),
    9,
  );
  await pageA.waitForTimeout(500);
  const preSplitCaret = await pageA.evaluate(() => {
    const sel = window.getSelection();
    return sel && sel.rangeCount > 0
      ? {
          anchorText: sel.anchorNode?.textContent ?? null,
          anchorOffset: sel.anchorOffset,
        }
      : null;
  });
  console.log("pre-split caret:", JSON.stringify(preSplitCaret));
  await pageA.keyboard.press("Enter");
  await pageA.waitForTimeout(1500);
  await snap(pageA, out, "2-split");

  const blocks = pageA.locator("[data-block-id]:has([data-block-text])");
  const blockCount = await blocks.count();
  r.ok("split: two text blocks", blockCount === 2, `count=${blockCount}`);

  const head = pageA
    .locator(`[data-block-id="${block1Id}"] [data-block-text]`)
    .first();
  const headText = await blockText(head);
  const tailBlockId = await pageA.evaluate((b1) => {
    const all = [...document.querySelectorAll("[data-block-id]")].filter((el) =>
      el.querySelector("[data-block-text]"),
    );
    return (
      all
        .map((el) => el.getAttribute("data-block-id"))
        .find((id) => id !== b1) ?? null
    );
  }, block1Id);
  console.log("block2 id:", tailBlockId);
  const tail = pageA
    .locator(`[data-block-id="${tailBlockId}"] [data-block-text]`)
    .first();
  const tailText = await blockText(tail);
  console.log("head text:", JSON.stringify(headText));
  console.log("tail text:", JSON.stringify(tailText));
  r.ok("split: head is 'alpha bol'", headText === "alpha bol");
  r.ok("split: tail starts with 'dy tail'", tailText.startsWith("dy tail"));
  r.ok("split: tail keeps the trailing text", tailText.endsWith("omega end"));

  const headBold = await head.evaluate((el) =>
    [...el.querySelectorAll("strong, .font-bold")]
      .map((n) => n.textContent)
      .join("|"),
  );
  const tailBold = await tail.evaluate((el) =>
    [...el.querySelectorAll("strong, .font-bold")]
      .map((n) => n.textContent)
      .join("|"),
  );
  r.ok("split: head bold = 'bol'", headBold === "bol", headBold);
  r.ok("split: tail bold = 'dy'", tailBold === "dy", tailBold);
  const tailDecorators = await tail.evaluate(
    (el) => el.querySelectorAll("[data-lexical-decorator]").length,
  );
  r.ok(
    "split: tail keeps both tokens",
    tailDecorators >= 2,
    `found ${tailDecorators}`,
  );

  // Caret should be in block2 at offset 0.
  const splitCaret = await pageA.evaluate((tid): SplitCaret => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { has: false };
    const el = document.querySelector(
      `[data-block-id="${tid}"] [data-block-text]`,
    );
    return {
      has: true,
      collapsed: sel.isCollapsed,
      inTail: !!el && el.contains(sel.anchorNode),
      anchorOffset: sel.anchorOffset,
    };
  }, tailBlockId);
  console.log("split caret:", JSON.stringify(splitCaret));
  r.ok(
    "split: caret in block2 at offset 0",
    splitCaret.has &&
      splitCaret.collapsed &&
      splitCaret.inTail &&
      splitCaret.anchorOffset === 0,
  );

  // Give the projection time to write both rows before the merge (checked in DB later
  // via the *merge* result; the split rows are transient).
  await pageA.waitForTimeout(2000);

  // --- 3. MERGE back with Backspace at start of block2 -------------------------
  await tail.click({ position: { x: 2, y: 12 } }); // caret to offset 0 (see above)
  await pageA.waitForTimeout(300);
  await pageA.keyboard.press("Backspace");
  await pageA.waitForTimeout(1500);
  await snap(pageA, out, "3-merged");

  const afterMergeCount = await blocks.count();
  r.ok(
    "merge: back to one text block",
    afterMergeCount === 1,
    `count=${afterMergeCount}`,
  );
  const mergedText = await blockText(head);
  console.log("merged text:", JSON.stringify(mergedText));
  r.ok(
    "merge: text equals pre-split text",
    mergedText === composedText,
    mergedText,
  );
  const mergedBold = await head.evaluate((el) =>
    [...el.querySelectorAll("strong, .font-bold")]
      .map((n) => n.textContent)
      .join(""),
  );
  r.ok(
    "merge: bold run restored to 'boldy'",
    mergedBold === "boldy",
    mergedBold,
  );
  const mergedDecorators = await head.evaluate(
    (el) => el.querySelectorAll("[data-lexical-decorator]").length,
  );
  r.ok(
    "merge: both tokens survive",
    mergedDecorators >= 2,
    `found ${mergedDecorators}`,
  );

  const mergeCaret = await pageA.evaluate((b1): MergeCaret => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { has: false };
    const el = document.querySelector(
      `[data-block-id="${b1}"] [data-block-text]`,
    );
    return {
      has: true,
      collapsed: sel.isCollapsed,
      inHead: !!el && el.contains(sel.anchorNode),
      anchorText: sel.anchorNode?.textContent ?? null,
      anchorOffset: sel.anchorOffset,
    };
  }, block1Id);
  console.log("merge caret:", JSON.stringify(mergeCaret));
  // Join offset is linear 9 = between "bol" and "dy" — after Lexical re-coalesces,
  // that's inside/at the boundary of the bold text ("bol"|3 or "boldy"|3).
  r.ok(
    "merge: caret collapsed at the join",
    mergeCaret.has &&
      mergeCaret.collapsed &&
      mergeCaret.inHead &&
      ((mergeCaret.anchorText === "bol" && mergeCaret.anchorOffset === 3) ||
        (mergeCaret.anchorText === "boldy" && mergeCaret.anchorOffset === 3) ||
        (mergeCaret.anchorText === "dy" && mergeCaret.anchorOffset === 0)),
  );

  // Let the merge projection land.
  await pageA.waitForTimeout(2500);

  // --- 4. Convergence in a second context --------------------------------------
  const { page: pageB } = await h.session({ label: "B" });
  await pageB.goto(pageUrl);
  const headB = pageB
    .locator(`[data-block-id="${block1Id}"] [data-block-text]`)
    .first();
  await headB.waitFor({ state: "visible", timeout: ELEMENT_TIMEOUT_MS });
  // Was a fixed `waitForTimeout(5000)` before this read. A second context
  // measured 6.7-11.2s to render text against main on an idle machine, so the
  // read could land before the text arrived and this check would report a
  // convergence failure that was the clock, not the app. Both demands are
  // unchanged — the merged text AND exactly one block.
  const converged = await waitFor(
    async () => ({
      text: await blockText(headB),
      count: await pageB
        .locator("[data-block-id]:has([data-block-text])")
        .count(),
    }),
    ({ text, count }) => text === mergedText && count === 1,
  );
  const { text: textB, count: countB } = converged.value;
  await snap(pageB, out, "4-context-b");
  console.log(
    "context B text:",
    JSON.stringify(textB),
    `(after ${converged.waitedMs}ms, ${converged.attempts} reads)`,
  );
  r.ok("converge: context B matches", converged.ok, `count=${countB}`);

  console.log("BLOCK1_ID:", block1Id);
  console.log("BLOCK2_ID:", tailBlockId);
  console.log("PAGE_URL:", pageUrl);

  await r.finish();
});
