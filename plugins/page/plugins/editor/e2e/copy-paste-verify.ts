// Copy/paste verification for the pages block editor, in a real browser.
// See research/2026-07-16-page-typed-block-markdown.md
//
// The defect: `blocksToMarkdown` duck-typed `data.text` as a string, so after
// the runs migration every copied block's text/plain flavor was empty — and a
// caret-in-block paste (handled by Lexical, which only reads text/plain) dumped
// whitespace-only paragraphs into one block. Verifies all three fixed flows:
//   A. block-selection copy writes real markdown text to the clipboard
//   B. block-selection paste round-trips blocks (BLOCKS_MIME)
//   B2. Cmd+Z undoes exactly that paste, leaving the trailing empty block —
//      paste is a recorded op, not a write that slips past the undo stack
//      (research/2026-07-30-page-record-paste-and-bulkmove-on-the-undo-stack.md)
//   C. caret-in-block paste of copied blocks inserts them as WHOLE blocks after
//      the caret's line — a block copied whole is never merged into its text
//   D. caret-in-block paste of external multi-line markdown splits into typed
//      blocks — and, starting with a heading, REPLACES the empty line it was
//      pasted into rather than landing below it
//   E. block-selection paste anchors on the selection's document-order END, so an
//      UPWARD-extended range is not split in half by its own copies
//      (research/2026-07-16-page-paste-anchor-selection-end.md)
//   F. a caret paste of FOREIGN markup whose text/html carries several blocks but
//      whose text/plain is one line lands inside the block, never as a second
//      paragraph in its root — the one-paragraph-per-block invariant, enforced by
//      `BlockClipboardInsertPlugin`. `decideTransfer` reads text/plain and declines
//      such a payload, so before the guard it reached Lexical's own insert, which
//      splits the paragraph. Real editors emit exactly this pair.
//   H. the reported case: `The plugin system⏎` pasted into an EMPTY block lands
//      in THAT block — no new block, the caret at the end of the text
//   I. `a⏎b` pasted MID-line splices at the caret: `The |plugin system` →
//      `The a`, `bplugin system`, the caret after `b`
//   J. one Cmd+Z takes the whole splice back — the new row AND the origin's text
//      — and Cmd+Shift+Z puts it back (research/2026-09-29-page-paste-splice-op.md)
//
// Usage: bun plugins/page/plugins/editor/e2e/copy-paste-verify.ts [--url <deploy>]
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { editableBlocks, openBlankPage } from "./support/blank-page";
import { blockSelectionDriver } from "./support/block-selection";
import { typeLines } from "./support/type-lines";

const r = report();

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { checkSelectionOwnsFocus, enterBlockSelection } = blockSelectionDriver(
    page,
    r,
  );

  await openBlankPage(page, { settleMs: 3000 });

  // Leave the trailing empty block; wait out the doc→data.text projection (~1s).
  await typeLines(page, ["alpha", "bravo", "charlie"], { trailingEnter: true });
  await page.waitForTimeout(2000);

  const blockTexts = (): Promise<string[]> =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-block-id] [data-block-text]")].map(
        (el) => (el.textContent ?? "").trim(),
      ),
    );

  r.eq("setup: three typed blocks", (await blockTexts()).slice(0, 3), [
    "alpha",
    "bravo",
    "charlie",
  ]);

  const block = (i: number) => editableBlocks(page).nth(i);

  // ---- A: block-selection copy writes real text/plain ------------------------
  await enterBlockSelection("A", 0, "Shift+ArrowDown"); // "alpha" + "bravo"
  await page.keyboard.press("Meta+c");
  await page.waitForTimeout(300);

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  r.eq("A: copied text/plain carries the block text", copied, "alpha\nbravo");

  // ---- B: block-selection paste (container path, BLOCKS_MIME) -----------------
  // The copies land after the selection's end ("bravo"), leaving the selected run
  // intact.
  await checkSelectionOwnsFocus("B (paste)");
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(2000); // server insert + push round-trip
  r.eq(
    "B: selection-mode paste inserts real copies",
    (await blockTexts()).slice(0, 6),
    ["alpha", "bravo", "alpha", "bravo", "charlie", ""],
  );

  // ---- B2: Cmd+Z undoes the paste ---------------------------------------------
  // The exact inverse of the reported symptom
  // (research/2026-07-30-page-record-paste-and-bulkmove-on-the-undo-stack.md):
  // Cmd+Z used to consume the PREVIOUS structural entry — the Enter that created
  // the trailing empty block — leaving the paste behind. So both halves matter:
  // the copies are gone AND the trailing empty block is still there.
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(2000); // patch POST + push round-trip
  r.eq("B2: Cmd+Z removes exactly the pasted blocks", await blockTexts(), [
    "alpha",
    "bravo",
    "charlie",
    "",
  ]);

  // Redo, so the phases below run against B's state (and the inverse pair is
  // itself covered — an undo whose redo cannot land is only half a fix).
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(2000);
  r.eq("B2: Cmd+Shift+Z puts them back", (await blockTexts()).slice(0, 6), [
    "alpha",
    "bravo",
    "alpha",
    "bravo",
    "charlie",
    "",
  ]);

  // ---- C: caret-in-block paste of copied blocks lands them as whole blocks ----
  await block(4).click(); // caret inside "charlie"
  await page.keyboard.press("End");
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(2000);
  r.eq(
    "C: caret-in-block paste inserts the copied blocks whole, after the line",
    (await blockTexts()).slice(0, 8),
    ["alpha", "bravo", "alpha", "bravo", "charlie", "alpha", "bravo", ""],
  );

  // ---- D: external multi-line markdown paste splits into typed blocks ---------
  await page.evaluate(() =>
    navigator.clipboard.writeText("# Head\n- bullet\n- [x] task done"),
  );
  const last = editableBlocks(page).last();
  await last.click(); // caret in the trailing empty block
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(2000);

  const tail = (await blockTexts()).slice(7);
  r.eq(
    "D: markdown lines became separate blocks, replacing the empty line",
    tail,
    ["Head", "bullet", "task done"],
  );
  const hasCheckbox = await page.evaluate(() =>
    [...document.querySelectorAll("[data-block-id]")].some((row) =>
      row.querySelector('[role="checkbox"], input[type="checkbox"]'),
    ),
  );
  r.eq("D: to-do rendered with checkbox chrome", hasCheckbox, true);
  // Block TYPES (heading-1 / bulleted-list / to-do + checked) are asserted
  // against the DB by the caller — the page URL is printed for that.
  console.log("PAGE_URL " + page.url());

  // ---- E: an UPWARD-extended selection pastes after its end, not its head ------
  // D left: alpha bravo alpha bravo charlie alpha bravo Head bullet "task done".
  // Extending up from "charlie" (block 4) puts the range's HEAD on "bravo"
  // (block 3) — the TOP of the run. Anchoring there is the defect: the copies
  // would land between the two selected blocks.
  await enterBlockSelection("E", 4, "Shift+ArrowUp"); // extended UP to "bravo"
  await page.keyboard.press("Meta+c");
  await page.waitForTimeout(300);
  await checkSelectionOwnsFocus("E (paste)");
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(2000);
  r.eq(
    "E: upward-extended selection pastes after its end",
    (await blockTexts()).slice(0, 9),
    [
      "alpha",
      "bravo",
      "alpha",
      "bravo",
      "charlie",
      "bravo",
      "charlie",
      "alpha",
      "bravo",
    ],
  );

  // ---- F: foreign multi-block HTML with one-line text/plain stays in the block --
  // Synthesised rather than copied, because the pair (multi-block text/html +
  // single-line text/plain) is what OTHER apps put on the clipboard — this
  // editor's own copy never writes text/html at all.
  // Phase E left block-selection mode on, whose floating SelectionBar sits over
  // the rows — leave it before reaching for a caret.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await block(0).click();
  await page.keyboard.press("End");
  await page.waitForTimeout(300);
  const beforeF = await blockTexts();
  await page.evaluate(() => {
    const el = document.querySelector(
      "[data-block-id] [data-block-text]",
    ) as HTMLElement | null;
    if (!el) throw new Error("no editable block");
    const dt = new DataTransfer();
    dt.setData("text/plain", "onetwo");
    dt.setData("text/html", "<p>one</p><p>two</p>");
    el.dispatchEvent(
      new ClipboardEvent("paste", {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await page.waitForTimeout(2000);
  const afterF = await blockTexts();
  r.eq("F: the paste minted no block", afterF.length, beforeF.length);
  // One block, both paragraphs' text, joined by the soft break a line boundary
  // inside a block already is. `textContent` reads the `<br>` as nothing.
  r.eq(
    "F: both paragraphs landed in the caret's block",
    afterF[0],
    "alphaonetwo",
  );
  const rootParagraphs = await page.evaluate(
    () =>
      document.querySelector("[data-block-id] [data-block-text]")
        ?.childElementCount ?? -1,
  );
  r.eq("F: the block's root still holds ONE paragraph", rootParagraphs, 1);

  // ---- G: a pasted README's blank lines are SPACING, not blocks ---------------
  // The regression `MarkdownContext.blankLines` exists to prevent, and the reason
  // the dialect is a required field rather than one rule for everybody. A blank
  // line between paragraphs is how markdown is written everywhere — a README, a
  // chat answer, anything an agent wrote — so a paste that read them as empty
  // paragraphs would double-space every one of them, and the user would delete
  // the spacers by hand. The paste sites declare `"separator"` and skip blank
  // lines; `read_page` and the clipboard COPY declare `"empty-block"` and write a
  // blank line for a real empty paragraph. Same bytes, opposite readings, decided
  // by the caller that knows which document it is holding.
  //
  // Asserted as a DELTA rather than against absolute indices, so the phases above
  // stay free to change what they leave behind.
  const beforeG = await blockTexts();
  await page.evaluate(() =>
    navigator.clipboard.writeText(
      "## Install\n\nRun the installer.\n\nThen restart the server.",
    ),
  );
  await editableBlocks(page).last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(2000);
  const afterG = await blockTexts();
  r.eq(
    "G: a README's three lines became three blocks, not five",
    afterG.length - beforeG.length,
    3,
  );
  r.eq("G: and its blank lines minted no empty paragraph", afterG.slice(-3), [
    "Install",
    "Run the installer.",
    "Then restart the server.",
  ]);

  // ---- H: the reported case — a lone line into an EMPTY block fills it --------
  // `The plugin system⏎` is what copying one line out of most editors puts on
  // the clipboard. It used to land as a NEW block below, leaving the block the
  // caret was in empty above it.
  await editableBlocks(page).last().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter"); // a fresh empty paragraph
  await page.waitForTimeout(1000);
  const beforeH = await blockTexts();
  r.eq("H: setup ends in an empty block", beforeH.at(-1), "");
  await page.evaluate(() =>
    navigator.clipboard.writeText("The plugin system\n"),
  );
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(2000);
  const afterH = await blockTexts();
  r.eq("H: the paste minted no block", afterH.length, beforeH.length);
  r.eq("H: the text is in THAT block", afterH.at(-1), "The plugin system");
  // The caret is at the end of the pasted text: typing continues the line.
  await page.keyboard.type("!");
  await page.waitForTimeout(1000);
  r.eq(
    "H: the caret sits at the end of the paste",
    (await blockTexts()).at(-1),
    "The plugin system!",
  );
  // Close the typing run (500 ms idle) so J's Cmd+Z reaches the splice, not it.
  await page.waitForTimeout(1000);

  // ---- I: a multi-line paste MID-line splices at the caret --------------------
  // The caret is PLACED rather than walked there with Home + arrows: those
  // proved unreliable in this position (the line's DOM caret stayed at 0), and
  // where the caret comes from is not what this phase tests.
  await editableBlocks(page).last().click();
  await page.evaluate(() => {
    const host = [
      ...document.querySelectorAll("[data-block-id] [data-block-text]"),
    ].at(-1);
    const walker =
      host && document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    const text = walker?.nextNode();
    if (!text) throw new Error("I: no text node in the last block");
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.setStart(text, "The ".length);
    range.collapse(true);
    sel.addRange(range);
  });
  await page.evaluate(() => navigator.clipboard.writeText("a\nb"));
  // Let the arrows' `selectionchange` reach Lexical's model first: a paste is
  // not in the event set Lexical re-derives its selection from the DOM on, so a
  // paste in the same task as the arrows would read the pre-arrow caret (the
  // stated bound in CLAUDE.md's splice section) — not what this phase tests.
  await page.waitForTimeout(300);
  r.eq(
    'I: setup — the DOM caret is after "The "',
    await page.evaluate(() => {
      const sel = window.getSelection();
      const host = document.activeElement;
      if (!sel || sel.rangeCount === 0 || !host) return "no selection";
      const range = document.createRange();
      range.setStart(host, 0);
      range.setEnd(sel.anchorNode!, sel.anchorOffset);
      return range.toString();
    }),
    "The ",
  );
  const beforeI = await blockTexts();
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(2000);
  const afterI = await blockTexts();
  r.eq("I: one block was added", afterI.length, beforeI.length + 1);
  r.eq(
    "I: the text before and after the caret wrapped the paste",
    afterI.slice(-2),
    ["The a", "bplugin system!"],
  );
  r.eq(
    "I: the caret landed in the paste's last line",
    await page.evaluate(() =>
      (document.activeElement?.textContent ?? "").trim(),
    ),
    "bplugin system!",
  );

  // ---- J: ONE Cmd+Z takes the whole splice back --------------------------------
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(2000);
  r.eq("J: Cmd+Z restores the line in one step", await blockTexts(), beforeI);
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(2000);
  r.eq("J: Cmd+Shift+Z re-applies it", await blockTexts(), afterI);

  await r.finish();
});
