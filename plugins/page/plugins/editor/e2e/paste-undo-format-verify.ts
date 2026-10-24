// Undoing a bold paste into an empty block leaves the caret UNMARKED.
//
// The bug: paste `<b>text</b>` into an empty block, ⌘Z, type — the typed text
// came out bold. Two leaks, both fixed and both needed here:
//  - the undo replay (`$spliceRunsInto`) emptied the paragraph but kept the
//    bold `textFormat` the reconciler had stamped on it (a synced property of
//    the block's doc), and
//  - the undo landing (`$placeCaretAtLinearOffset` → empty paragraph) kept the
//    previous selection's format, which Lexical never re-derives while the
//    whole root is empty.
//
// Subject is the persisted row: what the typed character carries is what
// reaches `data.text`.
//
// Manual-only; nothing runs this automatically.
// Usage: ./equin run plugins/page/plugins/editor/e2e/paste-undo-format-verify.ts
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { openBlankPage } from "./support/blank-page";
import { makeRunsReader } from "./support/runs";

const r = report();
const { settledRuns } = makeRunsReader();

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });
  const { pageId, blockId } = await openBlankPage(page, { settleMs: 3000 });

  await page.evaluate((id) => {
    const el = document.querySelector(
      `[data-block-id="${id}"] [contenteditable="true"]`,
    ) as HTMLElement | null;
    if (!el) throw new Error("no editable block");
    const dt = new DataTransfer();
    dt.setData("text/plain", "text");
    dt.setData("text/html", "<b>text</b>");
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  }, blockId);

  r.eq("pasted text is bold", await settledRuns(page, pageId, blockId), [
    { text: "text", marks: ["bold"] },
  ]);

  await page.keyboard.press("ControlOrMeta+z");
  r.eq("undo empties the block", await settledRuns(page, pageId, blockId), []);

  // Past Lexical's 200 ms collapsed-format carry window, so the assertion is
  // about the caret's durable format, not a timing artefact.
  await page.waitForTimeout(500);
  await page.keyboard.type("x");
  r.eq(
    "text typed after undo is NOT bold",
    await settledRuns(page, pageId, blockId),
    [{ text: "x", marks: [] }],
  );

  await r.finish();
});
