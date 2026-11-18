// Caret-in-block clipboard verification for the pages block editor, in a real
// browser.
//
// The rule under test (`web/components/block-forest-copy-plugin.tsx`):
//
//   > With NOTHING selected, the caret's own block IS the selection.
//
// so Cmd+C on a bare caret copies the whole block, Cmd+V lands it after that
// block (the existing `BlockForestPastePlugin`), and the pair is a two-keystroke
// duplicate. A real text range is untouched — the browser's own copy/paste still
// runs, inline, marks and all.
//
// Phases:
//   A. collapsed caret + Cmd+C writes the BLOCK to the clipboard (text/plain is
//      its markdown), where the native copy would have written nothing
//   B. Cmd+V after it duplicates the block in place
//   C. the subtree travels: copying a parent carries its indented child
//   D. a real text selection is STILL the browser's own text copy (the half that
//      must not regress) — asserted on the clipboard FLAVORS, which is where the
//      two paths visibly differ: the browser writes text/html beside the text,
//      this plugin writes text/plain alone
//   E. Cmd+X on a bare caret cuts the whole block
//   F. a ONE-STEP selection gesture (Shift+Home) followed IMMEDIATELY by Cmd+C
//      is still the browser's copy, and pastes back INLINE. The gap this closes:
//      Lexical's model selection is synced from the DOM on `selectionchange`, a
//      task later than the keystroke, so for that one task `$getSelection()`
//      still reports the pre-gesture COLLAPSED caret — and the plugin claimed
//      the copy, so the selected text pasted as a new block below instead of
//      landing inline (and Cmd+X would have deleted the block). The no-settle
//      timing IS the test: a settle re-tests phase D.
//
// Usage: bun plugins/page/plugins/editor/e2e/caret-clipboard-verify.ts [--url <deploy>]
import {
  report,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { editableBlocks, openBlankPage } from "./support/blank-page";
import { typeLines } from "./support/type-lines";

const r = report();

await withBrowser(async (h) => {
  const { context, page } = await h.session();
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  await openBlankPage(page, { settleMs: 3000 });

  // "alpha" / "bravo" / "charlie" indented under it.
  await typeLines(page, ["alpha", "bravo", { text: "charlie", indent: "in" }]);
  // Wait out the doc→`data.text` projection (~1s): `serializeForest` reads the
  // ROW's data, so a copy fired before it lands would carry empty text.
  await page.waitForTimeout(2000);

  const blockTexts = (): Promise<string[]> =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-block-id] [data-block-text]")].map(
        (el) => (el.textContent ?? "").trim(),
      ),
    );
  const block = (i: number) => editableBlocks(page).nth(i);
  const clipboardText = (): Promise<string> =>
    page.evaluate(() => navigator.clipboard.readText());
  /**
   * The clipboard's flavors — the observable that separates "this plugin wrote
   * it" from "the browser did". Chromium does not expose an unsanitized custom
   * type (`BLOCKS_MIME`) to `clipboard.read()`, so a block copy reads back as
   * `text/plain` ALONE while the browser's own text copy always adds
   * `text/html`. (That the structural payload really is on the clipboard is what
   * phases B/C assert, by pasting real blocks out of it.)
   */
  const clipboardTypes = (): Promise<string[]> =>
    page.evaluate(async () =>
      (await navigator.clipboard.read()).flatMap((item) => item.types),
    );
  const selectedText = (): Promise<string> =>
    page.evaluate(() => document.getSelection()?.toString() ?? "");

  r.eq("setup: three typed blocks", await blockTexts(), [
    "alpha",
    "bravo",
    "charlie",
  ]);

  // ---- A: collapsed caret + Cmd+C copies the BLOCK ---------------------------
  await page.evaluate(() => navigator.clipboard.writeText("SENTINEL"));
  await block(0).click(); // caret inside "alpha", nothing selected
  await page.keyboard.press("Meta+c");
  await page.waitForTimeout(300);
  // Not "SENTINEL": the native copy is a no-op on a collapsed caret, so a stale
  // clipboard is exactly the pre-change symptom.
  r.eq(
    "A: bare-caret copy writes the block's markdown",
    await clipboardText(),
    "alpha",
  );
  r.eq("A: and it is this plugin's payload", await clipboardTypes(), [
    "text/plain",
  ]);

  // ---- B: Cmd+V duplicates it in place ---------------------------------------
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(2000); // op POST + push round-trip
  r.eq("B: paste lands a copy right after the source", await blockTexts(), [
    "alpha",
    "alpha",
    "bravo",
    "charlie",
  ]);

  // ---- C: the copy carries the subtree ---------------------------------------
  // "bravo" owns the indented "charlie"; copying the parent must clone both.
  await block(2).click(); // caret inside "bravo"
  await page.keyboard.press("Meta+c");
  await page.waitForTimeout(300);
  r.eq(
    "C: a parent's copy carries its child",
    await clipboardText(),
    "bravo\n  charlie",
  );
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(2000);
  r.eq("C: the pasted subtree is both blocks", await blockTexts(), [
    "alpha",
    "alpha",
    "bravo",
    "charlie",
    "bravo",
    "charlie",
  ]);

  // ---- D: a real text selection is still the BROWSER's text copy -------------
  // The half that must not regress: with a range selected, the plugin declines
  // and Chromium's own copy runs — marks and all. What it pastes back into is
  // Lexical's business, not this plugin's, so the assertion is on the flavors
  // written, not on a downstream insert.
  await block(0).click();
  await page.keyboard.press("End");
  for (let i = 0; i < "alpha".length; i++) {
    await page.keyboard.press("Shift+ArrowLeft"); // select "alpha" inside the block
    await page.waitForTimeout(60);
  }
  // Asserted, not assumed: a selection that never took would leave a collapsed
  // caret, and this phase would silently re-test phase A.
  r.eq("D: the text range is selected", await selectedText(), "alpha");
  await page.keyboard.press("Meta+c");
  await page.waitForTimeout(300);
  r.eq(
    "D: text-range copy writes the selected text",
    await clipboardText(),
    "alpha",
  );
  r.eq("D: and it is the BROWSER's payload, not ours", await clipboardTypes(), [
    "text/plain",
    "text/html",
  ]);

  // ---- E: Cmd+X on a bare caret cuts the whole block --------------------------
  await block(1).click(); // caret inside the second "alpha", nothing selected
  await page.keyboard.press("Meta+x");
  await page.waitForTimeout(2000);
  r.eq("E: cut removes the caret's block", await blockTexts(), [
    "alpha",
    "bravo",
    "charlie",
    "bravo",
    "charlie",
  ]);
  r.eq("E: and it reached the clipboard", await clipboardText(), "alpha");
  r.eq("E: as a block payload", await clipboardTypes(), ["text/plain"]);

  // ---- F: a one-step selection gesture, copied before the model catches up ---
  // Deliberately NO wait between the gesture and Cmd+C — that gap is the whole
  // defect. `Shift+Home` goes from a caret to a full-line selection in ONE
  // press, so until `selectionchange` lands, Lexical's model still says
  // "collapsed" and the plugin used to read that as "nothing selected".
  const beforeF = await blockTexts();
  await block(0).click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Home");
  await page.keyboard.press("Meta+c");
  await page.waitForTimeout(300);
  r.eq("F: the whole line is selected", await selectedText(), "alpha");

  // The reported symptom, asserted first: pasted back at the end of the SAME
  // line it must land inline, not mint a block below. (Before the flavors read
  // below, which goes through `navigator.clipboard.read()` — that needs the
  // document focused and does not give the caret back.)
  //
  // The settle after `End` is the ONE place this phase wants one, and for the
  // mirror image of the reason it withholds one above: the model lags the
  // document here too, so pasting in the same task would land on the stale
  // RANGE and replace "alpha" with "alpha" — a pass-looking no-op that would
  // assert nothing. The race under test is the COPY's.
  await page.keyboard.press("End");
  await page.waitForTimeout(300);
  await page.keyboard.press("Meta+v");
  await page.waitForTimeout(2000);
  const afterF = await blockTexts();
  r.eq("F: the paste minted no block", afterF.length, beforeF.length);
  r.eq("F: it landed inline in the caret's block", afterF, [
    "alphaalpha",
    ...beforeF.slice(1),
  ]);
  r.eq(
    "F: a one-step selection is the BROWSER's copy, not ours",
    await clipboardTypes(),
    ["text/plain", "text/html"],
  );

  await r.finish();
});
