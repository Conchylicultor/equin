// Drop verification for the pages block editor, in a real browser. MANUAL ONLY
// — nothing runs this automatically.
//
// The defect: a DROP had no classifier in front of it. An external drag carries
// no Lexical marker, so `$handleRichTextDrop` declined, the browser performed
// its default action, and the resulting `beforeinput`/`insertFromDrop` reached
// `$insertDataTransferForRichText`'s plain-text arm — which calls
// `selection.insertParagraph()` per newline and dispatches NO command. Dropping
// multi-line text therefore left ONE block's Lexical root holding SEVERAL
// paragraphs, the state every caret/split/merge rule in the editor is written
// against. Pasting the same text had always become separate blocks.
//
// The fix: the block-editor CONTAINER classifies every drop through the same
// `decideTransfer` the pastes run, and claims it (`preventDefault`) unless it is
// a single line landing at an insertion point. A multi-line drop INTO a block's
// text is then SPLICED at the drop point (the `splice` op — the pointer is the
// insertion point, as the caret is for a paste). Verifies:
//   A. multi-line text dropped at the END of a block's text splices there: the
//      first line joins that line, the rest become blocks below it, and the
//      target block's root still holds exactly one paragraph
//   B. a single-line text drop inside a block's text is DECLINED, so the native
//      caret drop still owns it (no blocks minted)
//   C. a text drop on the page's whitespace (a row's gutter, below the measure)
//      becomes a new block
//   D. the dragover half: claimed over the page's chrome, declined over a
//      block's own text (single- vs multi-line is unknowable while the
//      DataTransfer is in protected mode, so that drag is left to the browser
//      and only reclaimed at drop time)
//   E. multi-line text dropped MID-text splices AT the pointer: `al|pha` +
//      `X⏎Y` → `alX`, `Ypha` — not a block after the row, which is where the
//      drop used to land whatever the pointer said
//
// KNOWN BOUND — read before adding an assertion here. These drops are SYNTHETIC
// (`new DragEvent(...)` with a hand-built `DataTransfer`), because an external
// OS drag cannot be originated from the page. A synthetic event is untrusted, so
// the browser performs NO default action for it either way: "the block's root
// still holds one paragraph" is therefore only evidence that OUR path minted no
// second paragraph, not that the default action was suppressed. The assertion
// that carries the mechanism is `dispatchEvent() === false`, i.e. the container
// called `preventDefault` — which is exactly what cancels the default action for
// a real drag. Do not "strengthen" this into a claim about the browser's own
// insert; it cannot be made here.
//
// Usage: bun plugins/page/plugins/editor/e2e/drop-verify.ts [--url <deploy>] [--headed]
import type { Page } from "playwright";
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { blockIdOf, editableBlocks, openBlankPage } from "./support/blank-page";
import { typeLines } from "./support/type-lines";

const r = report();

interface DragSpec {
  /** Which native event to synthesise. */
  type: "dragover" | "drop";
  /**
   * Aim at a CHARACTER instead of the target's box: the viewport point of the
   * caret position `offset` characters into the target's first text node.
   */
  charOffset?: number;
  /**
   * The event TARGET, which is what `isInsideEditingHost` reads: a block's
   * `[contenteditable]` is inside an editing host; a row element (its gutter
   * rail, the whitespace beside the measure) is not.
   */
  selector: string;
  /** The `text/plain` payload the transfer carries. */
  text: string;
  /** Pointer position: the target's middle, or 4px above its bottom edge. */
  at?: "center" | "bottom";
}

/**
 * Dispatch one synthetic drag event at a target and report whether the app
 * CLAIMED it — `dispatchEvent` returns false exactly when a listener called
 * `preventDefault`, which is the one observable that says so.
 */
function dragEvent(page: Page, spec: DragSpec): Promise<boolean> {
  return page.evaluate((s: DragSpec) => {
    const el = document.querySelector(s.selector);
    if (!el) throw new Error(`no element for ${s.selector}`);
    const box = el.getBoundingClientRect();
    let point = {
      x: box.left + box.width / 2,
      y: s.at === "bottom" ? box.bottom - 4 : box.top + box.height / 2,
    };
    if (s.charOffset !== undefined) {
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const text = walker.nextNode();
      if (!text) throw new Error(`no text node in ${s.selector}`);
      const range = document.createRange();
      range.setStart(text, s.charOffset);
      range.setEnd(text, s.charOffset);
      const rect = range.getBoundingClientRect();
      point = { x: rect.left, y: rect.top + rect.height / 2 };
    }
    const dt = new DataTransfer();
    dt.setData("text/plain", s.text);
    const event = new DragEvent(s.type, {
      dataTransfer: dt,
      bubbles: true,
      cancelable: true,
      clientX: point.x,
      clientY: point.y,
    });
    return !el.dispatchEvent(event);
  }, spec);
}

/** Every editable block's text, in document order. */
function blockTexts(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-block-id] [data-block-text]")].map(
      (el) => (el.textContent ?? "").trim(),
    ),
  );
}

/** How many paragraphs a block's Lexical root holds — the invariant under test. */
function rootParagraphs(page: Page, blockId: string): Promise<number> {
  return page.evaluate(
    (id) =>
      document.querySelector(`[data-block-id="${id}"] [data-block-text]`)
        ?.childElementCount ?? -1,
    blockId,
  );
}

await withBrowser(async (h) => {
  const { page } = await h.session();

  await openBlankPage(page, { settleMs: 3000 });
  // No trailing Enter: three blocks exactly, so a minted block is unambiguous.
  await typeLines(page, ["alpha", "bravo", "charlie"]);
  await page.waitForTimeout(2000); // the ~1s doc → data.text projection

  r.eq("setup: three typed blocks", await blockTexts(page), [
    "alpha",
    "bravo",
    "charlie",
  ]);

  const bravo = editableBlocks(page).nth(1);
  const bravoId = await blockIdOf(bravo);
  const bravoText = `[data-block-id="${bravoId}"] [data-block-text]`;
  const bravoRow = `[data-block-id="${bravoId}"]`;

  // ---- D: the dragover half ---------------------------------------------------
  // Over a block's own text a TEXT drag is left to the browser: we cannot yet
  // tell one line from several (protected mode), and the native caret drop is
  // the right answer for one line. Over the page's chrome there is no caret to
  // land in, so the container claims it and paints the scrim.
  r.eq(
    "D: a text dragover on a block's text is left to the browser",
    await dragEvent(page, { type: "dragover", selector: bravoText, text: "x" }),
    false,
  );
  r.eq(
    "D: a text dragover on the page's chrome is claimed",
    await dragEvent(page, { type: "dragover", selector: bravoRow, text: "x" }),
    true,
  );

  // ---- A: multi-line text dropped at the END of a block's text -----------------
  // The pointer is in the middle of the (wide) line box, past its last
  // character, so the insertion point is the end of "bravo": the first line
  // joins it and the rest land as the lines right below it.
  const claimedA = await dragEvent(page, {
    type: "drop",
    selector: bravoText,
    text: "one\ntwo\nthree",
    at: "bottom",
  });
  await page.waitForTimeout(2000); // server insert + push round-trip
  r.eq("A: the container claimed the drop", claimedA, true);
  r.eq("A: the drop spliced at the end of the line", await blockTexts(page), [
    "alpha",
    "bravoone",
    "two",
    "three",
    "charlie",
  ]);
  r.eq(
    "A: the target block's root still holds ONE paragraph",
    await rootParagraphs(page, bravoId),
    1,
  );

  // ---- B: a single line inside a block's text is declined ---------------------
  const before = await blockTexts(page);
  const claimedB = await dragEvent(page, {
    type: "drop",
    selector: bravoText,
    text: "just one line",
  });
  await page.waitForTimeout(1000);
  r.eq(
    "B: a single-line drop is left to the native caret drop",
    claimedB,
    false,
  );
  r.eq("B: it minted no block", await blockTexts(page), before);

  // ---- C: a text drop on the page's chrome becomes a block --------------------
  // The row element itself, at its bottom edge: a pointer on the gutter rail /
  // in the whitespace below the line, which is not an editing host and so has no
  // caret a single line could land in.
  const lastId = await blockIdOf(editableBlocks(page).last());
  const claimedC = await dragEvent(page, {
    type: "drop",
    selector: `[data-block-id="${lastId}"]`,
    text: "dropped in the margin",
    at: "bottom",
  });
  await page.waitForTimeout(2000);
  r.eq("C: the container claimed the drop", claimedC, true);
  r.eq("C: the line became its own block", await blockTexts(page), [
    ...before,
    "dropped in the margin",
  ]);

  // ---- E: multi-line text dropped MID-text splices at the pointer --------------
  const alphaId = await blockIdOf(editableBlocks(page).first());
  const beforeE = await blockTexts(page);
  const claimedE = await dragEvent(page, {
    type: "drop",
    selector: `[data-block-id="${alphaId}"] [data-block-text]`,
    text: "X\nY",
    charOffset: 2,
  });
  await page.waitForTimeout(2000);
  r.eq("E: the container claimed the drop", claimedE, true);
  r.eq("E: it spliced AT the pointer", await blockTexts(page), [
    "alX",
    "Ypha",
    ...beforeE.slice(1),
  ]);
  r.eq(
    "E: the origin's root still holds ONE paragraph",
    await rootParagraphs(page, alphaId),
    1,
  );

  console.log("PAGE_URL " + page.url());
  await r.finish();
});
