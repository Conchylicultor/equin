// Block-selection mode entry points, verified in a real browser.
// See research/2026-07-10-page-escape-block-selection.md
//
// The defect: the selection container's React `onKeyDown` re-handled the very
// keydown a block's Lexical handler had already consumed, because it asked
// `document.activeElement` (moved mid-dispatch by `focusContainer()`) instead of
// the event's own `e.target`. Escape therefore selected a block and immediately
// cleared it; Shift+Arrow at a block edge extended the range twice.
//
// Measured on the unfixed build: Escape -> "0 selected", Shift+ArrowUp -> "3 selected".
//
// Usage: bun plugins/page/plugins/editor/e2e/block-selection-verify.ts [--url <deploy>]
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { editableBlocks, openBlankPage } from "./support/blank-page";
import { highlightedLines } from "./support/block-selection";
import { typeLines } from "./support/type-lines";

const r = report();

await withBrowser(async (h) => {
  const { page } = await h.session();

  await openBlankPage(page, { settleMs: 3000 });

  // Four sibling blocks: alpha / bravo / charlie / delta, plus the trailing empty.
  await typeLines(page, ["alpha", "bravo", "charlie", "delta"], {
    trailingEnter: true,
  });
  await page.waitForTimeout(800);

  /** The selection bar's live count ("N selected"). The bar stays mounted (faded) at 0. */
  const selectedCount = (): Promise<number | null> =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll("span")].find((s) =>
        /^\d+ selected$/.test(s.textContent ?? ""),
      );
      const count = el?.textContent?.split(" ")[0];
      return count === undefined ? null : Number(count);
    });

  const containerFocused = (): Promise<boolean> =>
    page.evaluate(
      () =>
        document.activeElement?.getAttribute("aria-label") === "Page blocks",
    );

  const block = (i: number) => editableBlocks(page).nth(i);

  // A block's indent depth is rendered as the ROW's own left padding
  // (`contentLeft = BLOCK_GUTTER + depth * BLOCK_INDENT`), so the row's rect never
  // moves — its text does. Measure the contenteditable's left edge.
  const contentLeftOf = (i: number): Promise<number> =>
    page.evaluate((n) => {
      const editables = document.querySelectorAll(
        "[data-block-id] [data-block-text]",
      );
      return editables[n]?.getBoundingClientRect().left ?? -1;
    }, i);

  // 1. Escape inside a block enters selection mode (the reported bug).
  await block(2).click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  r.eq("Escape in a block selects it", await selectedCount(), 1);
  r.eq("Escape highlights exactly one row", await highlightedLines(page), 1);
  r.eq(
    "Escape focuses the selection container",
    await containerFocused(),
    true,
  );

  // 2. Escape in selection mode clears it (the branch the origin guard must keep).
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  r.eq("Escape again clears the selection", await selectedCount(), 0);
  r.eq("no row stays highlighted", await highlightedLines(page), 0);

  // 3. Shift+ArrowUp at a block's first line extends by exactly one block.
  await block(2).click();
  await page.keyboard.press("Home");
  await page.waitForTimeout(200);
  await page.keyboard.press("Shift+ArrowUp");
  await page.waitForTimeout(400);
  r.eq(
    "Shift+ArrowUp at the edge selects two blocks",
    await selectedCount(),
    2,
  );

  // 4. Tab in selection mode indents the selection — the affordance the bug hid.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await block(2).click();
  await page.waitForTimeout(200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  const before = await contentLeftOf(2);
  await page.keyboard.press("Tab");
  await page.waitForTimeout(800);
  const after = await contentLeftOf(2);
  r.eq("Tab indents the selected block", after - before, 24 /* BLOCK_INDENT */);
  r.eq("the selection survives the indent", await selectedCount(), 1);

  // 5. Shift+Tab puts it back.
  await page.keyboard.press("Shift+Tab");
  await page.waitForTimeout(800);
  r.eq("Shift+Tab outdents it again", await contentLeftOf(2), before);

  // 6. The selection survives an async refocus.
  // See research/2026-07-17-page-block-selection-focus-steal.md
  //
  // The defect: moving focus to the container left the text caret parked in the block
  // the user had just left. Lexical re-derives a commit's pending selection from the
  // DOM selection, so any UNTAGGED reconcile on that block — @lexical/yjs issues one
  // (`$ensureEditorNotEmpty`) outside its own tagged block, where Lexical's
  // COLLABORATION_TAG focus guard never sees it — concluded "the caret didn't move, so
  // my root should have focus" and called rootElement.focus() ~200-300ms later, with no
  // user input. `onFocusCapture` then read that as "the user clicked into a block" and
  // silently destroyed the selection; a subsequent Cmd+V failed the container's
  // activeElement guard and fell through to the per-block caret paste, landing in the
  // wrong place.
  //
  // Two things make it reproduce, and both are why it shipped unnoticed: a FRESH
  // navigation (so a content-doc hydration echo is still in flight) and NO settle
  // between the click and Escape. Every check above asserts immediately after the
  // keypress, where the state is still correct — the damage lands a beat later.
  // Measured on the unfixed build: 11/12 runs lost the selection.
  await page.reload();
  await block(1).waitFor({ state: "visible", timeout: 10000 });
  await block(1).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+ArrowDown");
  await page.waitForTimeout(1200);
  r.eq("the selection survives an async refocus", await selectedCount(), 2);
  r.eq(
    "the container still holds focus after the settle",
    await containerFocused(),
    true,
  );

  await r.finish();
});
