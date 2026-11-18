// Tab-indent / Shift+Tab-outdent caret-preservation verification.
//
// Indenting a block must not move the caret: Tab is a STRUCTURAL move (the row
// changes parent, the same block keeps its id, its editor, and its DOM focus),
// so the caret must stay exactly where the user left it — mid-word included.
// The regression this pins: the executor's post-op re-focus landed the caret at
// the block's content START ("rootStart"), so Tab silently sent the caret home.
//
//  1. blank page; type "hello" into the first block, Enter, type "second line";
//  2. put the caret mid-word (offset 6 of "second line"), press Tab;
//  3. assert: the block indented (its row's paddingLeft grew) AND the caret is
//     still collapsed in the SAME block at offset 6;
//  4. type a char → it lands at the caret, not at the block's start;
//  5. Shift+Tab (outdent) with the caret mid-text → same assertions in reverse.
//
// Usage: bun plugins/page/plugins/editor/e2e/indent-caret-verify.ts [--url <deploy>] [--out /tmp/ind]
import type { Page } from "playwright";
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { blockText, openBlankPage } from "./support/blank-page";

const out = arg("out", "/tmp/ind");
const r = report();

interface CaretRead {
  has: boolean;
  collapsed?: boolean;
  inBlock?: string | null;
  offset?: number;
}

/** Linear caret offset within a block, plus which block holds it. */
async function readCaret(page: Page): Promise<CaretRead> {
  return page.evaluate((): CaretRead => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return { has: false };
    const anchor = sel.anchorNode;
    const editable =
      anchor?.parentElement?.closest?.("[data-block-text]") ??
      (anchor instanceof Element ? anchor.closest("[data-block-text]") : null);
    if (!editable || !anchor) return { has: true, inBlock: null };
    // Linear offset = text before the anchor within the editable.
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.setEnd(anchor, sel.anchorOffset);
    return {
      has: true,
      collapsed: sel.isCollapsed,
      inBlock:
        editable.closest("[data-block-id]")?.getAttribute("data-block-id") ??
        null,
      offset: range.toString().length,
    };
  });
}

/** A block row's left padding — the rendered indent depth. */
async function rowPadding(page: Page, id: string): Promise<number> {
  return page.evaluate((bid: string) => {
    const el = document.querySelector(`[data-block-id="${bid}"]`);
    if (!el) return Number.NaN;
    return parseFloat(getComputedStyle(el).paddingLeft);
  }, id);
}

await withBrowser(async (h) => {
  const { page } = await h.session();

  await openBlankPage(page, { settleMs: 3000 });
  console.log("page url:", page.url());

  // --- 1. two blocks, the second one is the mover ----------------------------
  await page.keyboard.type("hello", { delay: 15 });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(600);
  await page.keyboard.type("second line", { delay: 15 });
  await page.waitForTimeout(2000);

  const moverId = (await readCaret(page)).inBlock;
  console.log("mover id:", moverId);
  r.ok("setup: caret is in the second block", moverId != null);
  if (!moverId) {
    // Nothing downstream is meaningful without the mover's id. The explicit
    // `return` is what narrows moverId to string for the rest of the run —
    // finish() is typed `never`, but control-flow narrowing off a method call
    // needs the callee's reference to be explicitly typed, which `r` is not.
    await r.finish();
    return;
  }

  // --- 2. caret mid-word, then Tab ------------------------------------------
  // From end-of-line (offset 11) back to offset 6 — inside "line".
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  const before = await readCaret(page);
  console.log("caret before Tab:", JSON.stringify(before));
  r.ok(
    "setup: caret parked mid-text at offset 6",
    before.offset === 6,
    `offset=${before.offset}`,
  );
  const padBefore = await rowPadding(page, moverId);

  await page.keyboard.press("Tab");
  await page.waitForTimeout(1200);
  await snap(page, out, "1-indented");

  const padAfter = await rowPadding(page, moverId);
  r.ok(
    "indent: the row actually indented",
    padAfter > padBefore,
    `${padBefore} → ${padAfter}`,
  );

  const afterTab = await readCaret(page);
  console.log("caret after Tab:", JSON.stringify(afterTab));
  r.ok(
    "indent: caret stays in the same block at the same offset",
    afterTab.has &&
      afterTab.collapsed === true &&
      afterTab.inBlock === moverId &&
      afterTab.offset === 6,
    JSON.stringify(afterTab),
  );

  // --- 3. typing lands at the caret, not at the block start ------------------
  await page.keyboard.type("X", { delay: 15 });
  await page.waitForTimeout(600);
  const mover = page
    .locator(`[data-block-id="${moverId}"] [data-block-text]`)
    .first();
  const typed = await blockText(mover);
  r.ok(
    "indent: the next char lands at the caret",
    typed === "secondX line",
    typed,
  );

  // --- 4. outdent with the caret mid-text ------------------------------------
  const beforeOutdent = await readCaret(page);
  console.log("caret before Shift+Tab:", JSON.stringify(beforeOutdent));
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(1200);
  await snap(page, out, "2-outdented");

  const padOut = await rowPadding(page, moverId);
  r.ok(
    "outdent: the row actually outdented",
    padOut < padAfter,
    `${padAfter} → ${padOut}`,
  );

  const afterOutdent = await readCaret(page);
  console.log("caret after Shift+Tab:", JSON.stringify(afterOutdent));
  r.ok(
    "outdent: caret stays in the same block at the same offset",
    afterOutdent.has &&
      afterOutdent.collapsed === true &&
      afterOutdent.inBlock === moverId &&
      afterOutdent.offset === beforeOutdent.offset,
    JSON.stringify(afterOutdent),
  );

  await r.finish();
});
