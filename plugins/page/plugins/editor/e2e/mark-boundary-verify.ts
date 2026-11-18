// Inline mark boundary caret — the virtual delimiter position
// (research/2026-08-06-page-inline-mark-boundary-caret.md, "Verification").
//
// A block ENDING with a marked run traps the caret inside the mark: `` `zz` `` at
// the end of a block is ONE TextNode carrying the `code` bit, and
// `offset === getTextContentSize()` is the last position that exists — so there
// is no "outside the span" to type plain text in. The fix gives every mark
// boundary one VIRTUAL stop (an invisible one-character delimiter, markdown-source
// style): ArrowRight steps onto it, ArrowLeft steps back inside, Backspace at it
// deletes the delimiter — i.e. strips the mark from the span.
//
// THE RULE: a boundary has TWO caret states, carrying the LEFT run's marks and
// the RIGHT run's; the browser hands you one (`natural`) and the stop is the
// OTHER one. A block edge is modelled as an empty unmarked neighbour, which is
// what makes block-start, block-end and mid-block one code path.
//
// Assertions run against the PERSISTED ROWS (`GET /api/pages/:pageId/blocks`)
// wherever the claim is about the data model — that is the only thing that proves
// the marks travelled Lexical → the block's `Y.Doc` → the ~1s `data.text`
// projection, and a DOM-only read would pass on a mark that never left the
// browser. It matters more here than in the sibling `inline-format-verify.ts`:
// `selection.format` is not readable from the DOM at all, so every claim about
// caret DEPTH can only be proven by what gets TYPED and persisted. The DOM is
// read for two things only — the caret's linear offset (the press-count claims of
// phase 6) and the rendered `<code>`/`<strong>` in the convergence phase.
//
// Phases:
//  1. `` `zz` ``, ArrowRight, SETTLE, `x` → [{zz,code},{x}]. THE load-bearing
//     assertion — see the long comment on that phase for why the settle is what
//     makes it one;
//  2. the step is reversible: same, then ArrowLeft, SETTLE, `x` → one {zzx,code}
//     run (the caret stepped back INSIDE the span);
//  3. Backspace at the stop deletes the delimiter: `` `zz` ``, ArrowRight,
//     Backspace → one UNMARKED `zz`; ONE Cmd+Z restores the `code` mark and
//     nothing else (the `stopCapturing()` fence on both sides of the strip);
//  4. THE `escaped` GATE — the safety property. Three shipped mechanisms produce
//     `selection.format ≠ node format` with no arrow step in sight, and under a
//     DERIVED depth each would make Backspace strip a whole span instead of
//     deleting a character. All three must take the ordinary deletion:
//     (a) `FormatShortcutsPlugin`'s collapsed-caret Cmd+E,
//     (b) `applyInlineFormat`'s `preFormat` restore after any autoformat,
//     (c) a programmatic merge landing at the end of a bold run;
//  5. block START is the same code path (the edge is an empty unmarked
//     neighbour): a block whose first run is bold — ArrowLeft, type → an unmarked
//     run lands FIRST;
//  6. a MID-BLOCK seam owns its stop too, and the mid-block case was broken
//     before this feature: Chromium biases the seam to the END of the left run,
//     so typing at `` `zz`|abc `` with no step comes out `{code}`-MARKED. Three
//     blocks: the unstepped baseline, the stop, and the crossing;
//  7. convergence in a second browser context (cold load, fresh socket);
//  8. TRAVERSAL SYMMETRY — walking a `` `aaa`a `` block all the way across in
//     BOTH directions must visit the same caret states in reverse order. A
//     per-direction spot check cannot see a skipped stop, because a stop is only
//     ever skipped on one approach; this is the phase that catches it.
//  9. THE MIRRORED SEAM — `` a`aaa` ``, the marked run on the RIGHT. The stop
//     there is the state INSIDE the code run at its start, so typing at it
//     PREPENDS into the span. The retired `left ∩ right` rule synthesized no
//     stop at all here (it computed `{}`, which `natural` already carried), so
//     that state was unreachable — the exact mirror of the block-end bug this
//     whole feature exists to fix. Same shape as phase 6 plus the traversal walk
//     of phase 8, in the other orientation, plus the forward strip;
// 10. CROSS-BLOCK ARRIVAL — a horizontal crossing INTO a block whose facing edge
//     is a mark boundary must meet the stop first, exactly as a within-block step
//     does. The block seam is a place the browser's own landing is the far state;
//     a click into the same position must NOT assert the stop.
// 11. CROSSING AN INLINE DECORATOR — the third arrival path, and the one the
//     caret-crossing channel exists for
//     (research/2026-08-08-global-caret-crossing-channel.md). A `` `code` `` run
//     next to a `[[page]]` chip: one arrow across the chip must land on the
//     boundary's stop, not inside the code run. Also pins the `selectNext(0, 0)`
//     fix and the Backspace-strip whose neighbour is a decorator;
//
// Manual-only; nothing runs this automatically.
// Usage: bun plugins/page/plugins/editor/e2e/mark-boundary-verify.ts [--url <deploy>] [--out /tmp/mark-boundary]
import {
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { pageLinkToken } from "@plugins/page/plugins/inline-page-link/core";
import { blockText, caretState, openBlankPage } from "./support/blank-page";
import { caretLinear, pressUntilLinear } from "./support/caret";
import { makeRunsReader } from "./support/runs";

const out = arg("out", "/tmp/mark-boundary");

const r = report();

// `mod+z` is the surface-level binding (one `useUndoRedoShortcuts` per tab, in
// apps-core/tab-surface); `mod+e` is the `code` mark in `format-shortcuts-plugin.tsx`.
// Playwright's `ControlOrMeta` is Meta on macOS and Control everywhere else, which
// is what both handlers actually test for (`event.metaKey || event.ctrlKey`).
const UNDO = "ControlOrMeta+z";
const CODE_MARK = "ControlOrMeta+e";
/** Phase 11 builds its fixture by PASTE — see the long comment there for why. */
const PASTE = "ControlOrMeta+v";

// --- waits --------------------------------------------------------------------

/**
 * After an inline-markdown autoformat: the transform runs in a `queueMicrotask`
 * off the update listener, then the collab binding flushes (~300ms debounce).
 */
const TRANSFORM_MS = 500;

/**
 * After an arrow step, BEFORE typing. This is not padding — it is the assertion.
 *
 * Lexical's format-divergence carry (`markCollapsedSelectionFormat`) is a ~200ms
 * window keyed on `(anchorKey, offset)`. Every autoformat already lands the caret
 * at `format = 0` on a marked node, so typing INSIDE that window proves nothing:
 * an implementation that stores no depth at all would produce the same rows. Idle
 * past the window and only a DURABLE store — re-asserted by the
 * `SELECTION_CHANGE_COMMAND` listener — can still be at depth 1.
 */
const FORMAT_WINDOW_MS = 700;

/** A structural op (the Backspace merge in phase 4c) reaching the rows. */
const OP_MS = 1500;

// --- persisted-row reads ------------------------------------------------------

/** Shared with `format-shortcuts-verify.ts` — see `support/runs.ts`. */
const { fetchRows, settledRuns } = makeRunsReader();

// --- DOM reads ----------------------------------------------------------------

/** Every editable block id in document order. */
async function editableIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("[data-block-id]")]
      .filter((el) => el.querySelector("[data-block-text]"))
      .map((el) => el.getAttribute("data-block-id") ?? ""),
  );
}

const editableOf = (page: Page, blockId: string) =>
  page.locator(`[data-block-id="${blockId}"] [data-block-text]`).first();

/**
 * The text of every `<tag>` Lexical rendered inside a block — the DOM proof of the
 * `theme.text` mapping (bold → `<strong>`, code → `<code>`, via Lexical's
 * `getElementInnerTag`). NBSP is normalized because Chromium renders a model-level
 * space as one at a text-node edge.
 */
async function markedTexts(
  page: Page,
  blockId: string,
  tag: string,
): Promise<string[]> {
  return page.evaluate(
    ([id, sel]) =>
      [...document.querySelectorAll(`[data-block-id="${id}"] ${sel}`)].map(
        (el) => (el.textContent ?? "").replace(/ /g, " "),
      ),
    [blockId, tag] as [string, string],
  );
}

/** The block the caret is currently in, or null — the "did it leave" test for a walk. */
async function caretBlockId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null;
    const anchor = sel.anchorNode;
    const el = anchor instanceof Element ? anchor : anchor.parentElement;
    return (
      el?.closest("[data-block-id]")?.getAttribute("data-block-id") ?? null
    );
  });
}

/**
 * Is the caret's anchor node inside a `<code>` element — i.e. did Chromium bias
 * the seam to the END of the code node rather than the START of the plain one?
 *
 * Diagnostic only (phase 6 notes it); the phase's verdict comes from the rows.
 */
async function caretInsideCode(page: Page): Promise<boolean | null> {
  return page.evaluate(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || !sel.anchorNode) return null;
    const node = sel.anchorNode;
    const el = node instanceof Element ? node : node.parentElement;
    return el?.closest("code") != null;
  });
}

// --- caret placement ----------------------------------------------------------

/**
 * Park the caret at the very START of `id`'s text.
 *
 * Home / Cmd+ArrowLeft do not move the caret in headless Chromium on macOS (two
 * sibling scripts say so), so this is the click-the-left-edge + exact-count
 * ArrowLeft fallback from `backspace-indent-verify.ts`. It stops the MOMENT the
 * offset reads 0, which matters here and nowhere else: one further ArrowLeft at a
 * block whose first run is marked is precisely the virtual step phase 5 tests, so
 * an over-pressing loop would arrive already `escaped`.
 */
async function caretToStartOf(page: Page, id: string): Promise<void> {
  await editableOf(page, id).click({ position: { x: 2, y: 8 } });
  await page.waitForTimeout(200);
  for (let guard = 0; guard < 40; guard++) {
    if ((await caretLinear(page)) <= 0) return;
    await page.keyboard.press("ArrowLeft");
  }
  throw new Error(`caret never reached the start of ${id}`);
}

/**
 * Park the caret at the very END of `id`'s text — the precondition for `Enter`
 * meaning "new block below" rather than "split this one".
 *
 * The sibling `inline-format-verify.ts` needs no such helper because each of its
 * phases ends with the caret already at the document end. Two phases here
 * deliberately leave it mid-block (the merge in 4c, the seam in 6), so the
 * fixture builder parks it rather than assuming.
 */
async function caretToEndOf(page: Page, id: string): Promise<void> {
  const editable = editableOf(page, id);
  const box = await editable.boundingBox();
  if (!box) throw new Error(`block ${id} has no box`);
  const len = await editable.evaluate((el) => (el.textContent ?? "").length);
  await editable.click({ position: { x: Math.max(box.width - 4, 4), y: 8 } });
  await page.waitForTimeout(200);
  for (let guard = 0; guard < 60; guard++) {
    if ((await caretLinear(page)) >= len) return;
    await page.keyboard.press("ArrowRight");
  }
  throw new Error(`caret never reached the end of ${id}`);
}

// --- authoring helpers --------------------------------------------------------

/**
 * A fresh empty block at the end of the document, whose id is returned.
 *
 * Parks the caret at the end of the LAST block first (see `caretToEndOf`), then
 * diffs the id sets rather than assuming "the new block is last" — a silent
 * mis-identification would attribute the next phase's assertions to the wrong row.
 *
 * It then waits for the new block's ROW to exist server-side, which is not padding
 * but the doc-init gate itself: a freshly split block mounts its editor from the
 * optimistic overlay BEFORE the structural POST creates its `page_blocks` row, and
 * its content `Y.Doc` cannot seed until that row is confirmed. Typing into that gap
 * races the seed, and every phase here opens by typing an autoformat sequence.
 * `inline-format-verify.ts`'s copy of this helper documents the two failures
 * observed while it was a blind sleep.
 */
async function enterNewBlock(page: Page, pageId: string): Promise<string> {
  const before = await editableIds(page);
  const last = before.at(-1);
  if (!last) throw new Error("document has no editable block");
  await caretToEndOf(page, last);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const after = await editableIds(page);
  const fresh = after.filter((id) => !before.includes(id));
  if (fresh.length !== 1 || !fresh[0]) {
    throw new Error(
      `Enter did not create exactly one block: ${JSON.stringify({ before, after })}`,
    );
  }
  const id = fresh[0];
  const deadline = Date.now() + 20_000;
  for (;;) {
    if ((await fetchRows(pageId)).has(id)) break;
    if (Date.now() > deadline)
      throw new Error(`block ${id} never reached the server`);
    await page.waitForTimeout(250);
  }
  // The row is confirmed, so doc-init is now unblocked; give its round trip a beat
  // before the first keystroke.
  await page.waitForTimeout(800);
  return id;
}

await withBrowser(async (h) => {
  const { context, page } = await h.session({ label: "A" });
  // Phase 11 alone needs the clipboard: its fixture is a PASTE, because that is
  // the only way to materialize an inline decorator chip in a block (see there).
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  const {
    pageUrl,
    pageId,
    blockId: firstId,
  } = await openBlankPage(page, {
    settleMs: 3000,
  });
  console.log("page url:", pageUrl);
  console.log("PAGE_ID:", pageId);

  // --- Phase 1: the stop exists, and typing there is UNMARKED ----------------
  //
  // THE load-bearing assertion in this file, and the whole feature in one line:
  // before it, `[{zz,code}]` was a block you could not type plain text at the end
  // of, because no caret position existed outside the span.
  //
  // The SETTLE between the ArrowRight and the `x` is what makes it load-bearing
  // rather than vacuous. `applyInlineFormat` restores `preFormat` (0) onto the
  // post-transform caret, so the caret sitting on a `{code}` node with
  // `format = 0` is the state EVERY autoformat already leaves behind — typing
  // immediately would produce these same rows with no feature at all. That
  // divergence survives only inside Lexical's ~200ms `markCollapsedSelectionFormat`
  // window, and `shouldSkipSelectionChange` explicitly does NOT skip at
  // `offset === length`, so an ArrowRight there re-derives `{code}` from the node.
  // Waiting the window out means only a STORED, re-asserted depth can still be at
  // the stop when `x` is typed.
  const p1 = firstId;
  await page.keyboard.type("`zz`", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  // Not an assertion: the caret is at the same linear offset and the same pixel at
  // depth 0 and depth 1. Logged because a caret that MOVED (or left the block)
  // explains a phase-1 failure that the rows alone would not.
  console.log(
    "P1 caret at the stop:",
    JSON.stringify(await caretState(editableOf(page, p1))),
  );
  console.log("P1 linear offset:", await caretLinear(page));
  await page.keyboard.type("x", { delay: 25 });
  await snap(page, out, "1-step-out");
  r.eq(
    "P1 ArrowRight reaches a stop OUTSIDE the mark; typing there is unmarked",
    await settledRuns(page, pageId, p1),
    [
      { text: "zz", marks: ["code"] },
      { text: "x", marks: [] },
    ],
  );
  {
    // The DOM dual, and the proof the caret landed AFTER the span rather than
    // inside it: `x` sits outside the `<code>`.
    const codes = await markedTexts(page, p1, "code");
    r.eq("P1 <code> holds only 'zz'", codes, ["zz"]);
  }

  // --- Phase 2: the step is REVERSIBLE ---------------------------------------
  // One ArrowLeft from the stop is the delimiter crossed the other way, so the
  // caret is back INSIDE the span and typing is marked again. Same settle, same
  // reason: at depth 0 the format is re-derived from the node and is stable, so a
  // pass here cannot be a leftover timing window either.
  const p2 = await enterNewBlock(page, pageId);
  await page.keyboard.type("`zz`", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  await page.keyboard.type("x", { delay: 25 });
  await snap(page, out, "2-step-back-in");
  r.eq(
    "P2 ArrowLeft steps back INSIDE the mark",
    await settledRuns(page, pageId, p2),
    [{ text: "zzx", marks: ["code"] }],
  );

  // --- Phase 3: Backspace at the stop deletes the DELIMITER -------------------
  // Which is what "strip the mark from the span" means in this model — the
  // markdown-source behavior, without markdown source. The undo half is the other
  // requirement: `recordDocEdit` records the strip as its own data entry,
  // fenced off the typing run on BOTH sides (the run tracker's `untracked`
  // scope closes the open run first and ignores the strip), so ONE Cmd+Z
  // restores the mark and nothing else. Unlike the sibling script's undo phase,
  // the press count here IS the claim — it is a property of the fence, not of
  // the 500ms idle grouping.
  const p3 = await enterNewBlock(page, pageId);
  await page.keyboard.type("`zz`", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  await page.keyboard.press("Backspace");
  await snap(page, out, "3-unmark");
  r.eq(
    "P3 Backspace at the stop strips the mark from the span",
    await settledRuns(page, pageId, p3),
    [{ text: "zz", marks: [] }],
  );
  {
    const codes = await markedTexts(page, p3, "code");
    r.ok(
      "P3 the <code> is gone from the DOM too",
      codes.length === 0,
      JSON.stringify(codes),
    );
  }

  await page.keyboard.press(UNDO);
  await snap(page, out, "3-unmark-undone");
  {
    const runs = await settledRuns(page, pageId, p3);
    r.eq("P3 ONE Cmd+Z restores the {code} mark", runs, [
      { text: "zz", marks: ["code"] },
    ]);
    // "…and nothing else": had the strip merged into the typing run's undo item,
    // the same press would have taken the autoformat with it and put the literal
    // delimiters back.
    const visible = await blockText(editableOf(page, p3));
    r.ok(
      "P3 the undo did not also revert the autoformat",
      visible === "zz",
      JSON.stringify(visible),
    );
  }

  // --- Phase 4: THE `escaped` GATE (the safety property) ---------------------
  //
  // Depth is STORED, never derived from `selection.format`, and this phase is why.
  // Three shipped mechanisms produce `selection.format ≠ node format` with no
  // arrow step anywhere in the interaction. Under a derived depth each of them
  // would arm the unmark rung, so the user's next Backspace would silently strip
  // formatting from a whole span instead of deleting one character — an invisible,
  // destructive edit sitting on the undo stack. Each sub-case below is one of
  // them, and each asserts the SAME thing: a character went, the mark stayed.
  //
  // The discriminator is sharp in every case: a stripped span leaves the text
  // intact and the marks empty; an ordinary deletion leaves the text one character
  // shorter and the marks alone.

  // (a) `FormatShortcutsPlugin`'s Cmd+E fires on a collapsed caret BY DESIGN, and
  //     Lexical's collapsed branch of `formatText` is a pure selection toggle — so
  //     Cmd+E at the end of a `{code}` run yields `format = N \ {code}`,
  //     BIT-IDENTICAL to depth 1.
  const p4a = await enterNewBlock(page, pageId);
  await page.keyboard.type("`zz`", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await page.keyboard.press(CODE_MARK);
  await page.waitForTimeout(300);
  await page.keyboard.press("Backspace");
  await snap(page, out, "4a-cmd-e");
  r.eq(
    "P4a Cmd+E does NOT arm the unmark — Backspace deletes a character",
    await settledRuns(page, pageId, p4a),
    [{ text: "z", marks: ["code"] }],
  );

  // (b) `applyInlineFormat` snapshots `preFormat` and restores it onto the
  //     post-transform caret, so EVERY successful autoformat lands at
  //     `format = 0` on a marked node — a fabricated depth 1, on the single most
  //     common path in the editor. Expected here: the block goes EMPTY (`b` was
  //     the only character). A stripped span would instead leave `[{b}]` — same
  //     text, no bold.
  const p4b = await enterNewBlock(page, pageId);
  await page.keyboard.type("**b**", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await page.keyboard.press("Backspace");
  await snap(page, out, "4b-autoformat");
  r.eq(
    "P4b an autoformat landing does NOT arm the unmark — the character goes",
    await settledRuns(page, pageId, p4b),
    [],
  );

  // (c) Programmatic caret landings. `appendRunsAtJoin` focuses an editor with no
  //     prior selection (format 0) and lands the caret at the end of a
  //     possibly-bold run — and `$placeCaretAtLinearOffset` deliberately resolves
  //     a boundary to the END OF THE EARLIER LEAF, which is exactly where depth
  //     lives. A Backspace-merge into a bold-ENDING block is that landing, reached
  //     the way a user reaches it.
  //
  //     The merged-in block is EMPTY on purpose. Merging a non-empty block would
  //     land the caret at a `{bold}`→`{}` seam, which needs no virtual stop at all
  //     — so the assertion would pass on the suppression rule and say nothing
  //     about the gate. Empty, the landing is at the block END, where a stop
  //     genuinely exists and only `escaped` stands between this Backspace and a
  //     stripped span.
  const p4c1 = await enterNewBlock(page, pageId);
  await page.keyboard.type("**bold**", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  const p4c2 = await enterNewBlock(page, pageId);
  await caretToStartOf(page, p4c2);
  await page.keyboard.press("Backspace"); // merge: caret lands at the join
  await page.waitForTimeout(OP_MS);
  {
    const ids = await editableIds(page);
    r.ok(
      "P4c the merge consumed the empty block",
      !ids.includes(p4c2),
      JSON.stringify(ids),
    );
    r.eq(
      "P4c the caret landed at the join, end of the bold run",
      await caretLinear(page),
      4,
    );
  }
  await page.keyboard.press("Backspace"); // the keystroke under test
  await snap(page, out, "4c-merge-landing");
  r.eq(
    "P4c a merge landing does NOT arm the unmark — one character goes, bold survives",
    await settledRuns(page, pageId, p4c1),
    [{ text: "bol", marks: ["bold"] }],
  );

  // --- Phase 5: block START is the same code path ----------------------------
  // A block edge is modelled as an EMPTY UNMARKED NEIGHBOUR, which is the one
  // choice that makes block-start, block-end and mid-block a single code path. So
  // the mirror of phase 1 needs no mirror code: the boundary at offset 0 has
  // `left = {}` (the edge), `right = {bold}`, and its stop carries `{}` — one
  // ArrowLeft reaches it, and the text typed there lands as an unmarked run
  // BEFORE the bold one.
  const p5 = await enterNewBlock(page, pageId);
  await page.keyboard.type("**bb**", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await page.keyboard.type(" tail", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await caretToStartOf(page, p5);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  r.eq(
    "P5 the step at block start consumed the press (caret still at offset 0)",
    await caretLinear(page),
    0,
  );
  await page.keyboard.type("x", { delay: 25 });
  await snap(page, out, "5-block-start");
  r.eq(
    "P5 typing at the block-start stop lands an UNMARKED run first",
    await settledRuns(page, pageId, p5),
    [
      { text: "x", marks: [] },
      { text: "bb", marks: ["bold"] },
      { text: " tail", marks: [] },
    ],
  );

  // --- Phase 6: a mid-block seam owns its stop, and always needed one ---------
  //
  // MEASURED — and it falsified the design's one assumption. The plan predicted
  // that `` `zz`|plain `` would need NO stop: `L = {code}`, `R = {}`,
  // `L ∩ R = {}`, and the plain run's own start position already carries `{}`.
  // That reasoning is sound only if Chromium resolves the seam to the PLAIN node.
  // It does not — it biases to the END of the code node (the `caretInsideCode`
  // probe below reads `true`), so the caret's NATURAL marks there are `{code}`,
  // they differ from the plain run's, and `virtualStop` synthesizes a stop like
  // at any other boundary.
  //
  // Two consequences, and the second is why this phase now opens with a baseline:
  //
  //  - EVERY boundary costs one extra press, not only the disjoint-mark seams the
  //    plan expected. That is the trade taken deliberately — the caret behaves
  //    the same everywhere — not a regression to tune away.
  //  - THE MID-BLOCK CASE WAS BROKEN BEFORE THIS FEATURE. Under the left bias,
  //    typing at the seam produced a `{code}`-MARKED character in a run the user
  //    is typing outside of. So the feature fixes mid-block; it does not merely
  //    extend block edges. Phase 6a is the only assertion in this file that says
  //    so, and it is the whole regression value of the mid-block half.
  //
  // The stop's DIRECTION needed no change for any of this, because it asks the
  // LIVE anchor what its marks are instead of predicting the browser. The finding
  // cost a test expectation, not a redesign — which is the argument for keeping
  // it derived from the anchor if anyone is ever tempted to precompute it.
  //
  // Three blocks, one claim each: typing mutates the fixture, so they cannot
  // share one.

  /** A fresh `[{zz,code},{abc}]` block, caret parked AT the seam (linear 2). */
  const seamBlock = async (label: string): Promise<string> => {
    const id = await enterNewBlock(page, pageId);
    await page.keyboard.type("`zz`", { delay: 25 });
    await page.waitForTimeout(TRANSFORM_MS);
    await page.keyboard.type("abc", { delay: 25 });
    await page.waitForTimeout(TRANSFORM_MS);
    await caretToStartOf(page, id);
    // Walk to the seam rather than counting presses from the block start:
    // whether the block-START boundary absorbs an ArrowRight is phase 5's
    // business, not this one's. `pressUntilLinear` stops the MOMENT it reads 2,
    // so it never presses the absorbed one — the fixture cannot consume the
    // press the phase is about to measure.
    const presses = await pressUntilLinear(page, "ArrowRight", 2);
    r.ok(
      `${label} the caret reached the \`zz\`|abc seam`,
      presses >= 0,
      `presses=${presses}`,
    );
    return id;
  };

  // (a) The baseline: no step at all. This is what the editor did before the
  //     feature, and it is a defect — the caret is visually outside the code span
  //     and types inside it.
  const p6a = await seamBlock("P6a");
  r.note(
    `P6a seam anchor is inside <code>: ${String(await caretInsideCode(page))} ` +
      `(true = Chromium biases the seam LEFT, which is what makes the stop necessary)`,
  );
  await page.keyboard.type("X", { delay: 25 });
  await snap(page, out, "6a-seam-unstepped");
  {
    const runs = await settledRuns(page, pageId, p6a);
    r.ok(
      "P6a WITHOUT a step the seam types INSIDE the mark — the pre-feature defect",
      JSON.stringify(runs) ===
        JSON.stringify([
          { text: "zzX", marks: ["code"] },
          { text: "abc", marks: [] },
        ]),
      `got ${JSON.stringify(runs)} — [{zz,code},{Xabc}] would mean Chromium now anchors the seam to the ` +
        `PLAIN node, i.e. the bias this whole phase records has flipped: 6b/6c below are then asserting ` +
        `a stop that should no longer be synthesized, and the mid-block half of the feature is moot`,
    );
  }

  // (b) One press is ABSORBED by the stop — the caret does not move, and typing
  //     there is unmarked. The two halves of one claim: a press that moved would
  //     put `X` after `a`, and a stop carrying the wrong marks would leave `X`
  //     inside the code run.
  const p6b = await seamBlock("P6b");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  r.eq(
    "P6b the stop absorbs the first ArrowRight (linear stays 2)",
    await caretLinear(page),
    2,
  );
  await page.keyboard.type("X", { delay: 25 });
  await snap(page, out, "6b-seam-stop");
  {
    const runs = await settledRuns(page, pageId, p6b);
    r.ok(
      "P6b typing AT the seam's stop is unmarked, before the plain run",
      JSON.stringify(runs) ===
        JSON.stringify([
          { text: "zz", marks: ["code"] },
          { text: "Xabc", marks: [] },
        ]),
      `got ${JSON.stringify(runs)} — [{zzX,code},{abc}] means the step did not change the caret's marks ` +
        `(the stop exists but carries \`natural\` instead of L ∩ R); [{zz,code},{aXbc}] means the press ` +
        `moved instead of being absorbed`,
    );
  }

  // (c) The second press crosses. Asserted on the rows as well as the offset:
  //     `X` after `a` is the only thing that proves the press moved the caret
  //     rather than being absorbed a second time at the same position.
  const p6c = await seamBlock("P6c");
  await page.keyboard.press("ArrowRight"); // absorbed by the stop
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowRight"); // crosses
  await page.waitForTimeout(200);
  r.eq(
    "P6c a SECOND ArrowRight crosses the seam (linear 2 → 3)",
    await caretLinear(page),
    3,
  );
  await page.keyboard.type("X", { delay: 25 });
  await snap(page, out, "6c-seam-crossed");
  {
    const runs = await settledRuns(page, pageId, p6c);
    r.ok(
      "P6c after crossing, the char lands one position INTO the plain run",
      JSON.stringify(runs) ===
        JSON.stringify([
          { text: "zz", marks: ["code"] },
          { text: "aXbc", marks: [] },
        ]),
      `got ${JSON.stringify(runs)} — [{zz,code},{Xabc}] means the second press was absorbed too, i.e. the ` +
        `stop is not a single caret stop but a state the caret cannot leave rightward`,
    );
  }

  // --- Phase 8: TRAVERSAL SYMMETRY -------------------------------------------
  //
  // The regression phase. Phases 1-6 are per-direction spot checks, and that is
  // exactly what let an asymmetry ship: the RIGHTWARD path across a seam
  // (`inside → stop → across`) was pinned by 6b/6c, the leftward one was not — and
  // ArrowLeft skipped the stop entirely, landing the caret INSIDE the code run one
  // press early. The browser resolves a seam to the same anchor whichever way the
  // caret came from, so a stop is only ever skipped on ONE approach, which is
  // precisely the shape a per-direction test cannot see.
  //
  // The claim is stated on the OFFSET SEQUENCE, which is all the DOM can give:
  // walk the caret across the whole block one press at a time, recording its
  // linear offset before the first press and after each one, until it leaves the
  // block. A press absorbed by a stop repeats an offset, so the sequence encodes
  // both WHERE the caret went and WHICH presses were absorbed. For `` `aaa`a ``:
  //
  //   rightward   0 0 1 2 3 3 4      (0* → 0 → 1 → 2 → 3 → 3* → 4)
  //   leftward    4 3 3 2 1 0 0      (4 → 3* → 3 → 2 → 1 → 0 → 0*)
  //
  // and each must be the exact reverse of the other. Note the repeats sit at
  // OPPOSITE ends of the two sequences — that is the symmetry, and reversing one
  // is the only way to state it that a single direction cannot satisfy alone.

  /** A fresh `[{aaa,code},{a}]` block — a marked run, a plain run, one seam. */
  const traversalBlock = async (): Promise<string> => {
    const id = await enterNewBlock(page, pageId);
    await page.keyboard.type("`aaa`", { delay: 25 });
    await page.waitForTimeout(TRANSFORM_MS);
    // Typing straight after an autoformat lands OUTSIDE the span (the caret's
    // restored `preFormat` is 0), so this `a` is its own unmarked run — the same
    // path phase 1 asserts, reused here as a fixture.
    await page.keyboard.type("a", { delay: 25 });
    await page.waitForTimeout(TRANSFORM_MS);
    // A trailing sentinel, so the RIGHTWARD walk has somewhere to exit to.
    // `enterNewBlock` appends at the document end, so without this the block
    // under test is the last one on the page: `nav right` at its end has no
    // destination, the caret cannot leave, and the walk spins to its guard —
    // which is a fixture fault that reads exactly like a product bug. The
    // leftward walk needs no counterpart; every earlier phase left blocks above.
    await enterNewBlock(page, pageId);
    return id;
  };

  /**
   * Press `key` until the caret leaves `id`, returning its linear offset before
   * the first press and after each one.
   */
  const walk = async (id: string, key: string): Promise<number[]> => {
    const seen: number[] = [await caretLinear(page)];
    for (let guard = 0; guard < 12; guard++) {
      await page.keyboard.press(key);
      await page.waitForTimeout(120);
      if ((await caretBlockId(page)) !== id) return seen;
      seen.push(await caretLinear(page));
    }
    // The recorded sequence IS the diagnosis, so it must survive the throw: a
    // caret pinned at the block's LAST offset (`…,4,4,4`) never had anywhere to
    // exit to — a missing neighbouring block, i.e. this script's fixture at
    // fault — whereas a run at any INTERIOR offset (`…,3,3,3`) is a press being
    // absorbed over and over at one position, i.e. a stop the caret cannot
    // leave, which is the product. Discarding `seen` makes those two identical.
    throw new Error(
      `the caret never left ${id} after 12 ${key} presses — offsets ${JSON.stringify(seen)}; ` +
        `a run at the block's last offset is a missing exit block (fixture), a run at an ` +
        `interior offset is a stop the caret cannot leave (product)`,
    );
  };

  const p8 = await traversalBlock();
  // Start at the block-START stop, the leftmost state of all: `caretToStartOf`
  // stops the moment the offset reads 0 (i.e. at `natural`), so one more
  // ArrowLeft is the block-start delimiter — the mirror of the seam's stop at the
  // other end, and what makes the two walks cover the same state set.
  await caretToStartOf(page, p8);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  const rightward = await walk(p8, "ArrowRight");
  r.eq(
    "P8 rightward visits every state in order",
    rightward,
    [0, 0, 1, 2, 3, 3, 4],
  );

  await caretToEndOf(page, p8);
  const leftward = await walk(p8, "ArrowLeft");
  r.eq(
    "P8 leftward visits the same states in reverse",
    leftward,
    [4, 3, 3, 2, 1, 0, 0],
  );
  r.eq(
    "P8 the two walks are exact mirror images",
    [...leftward].reverse(),
    rightward,
  );

  // And the marks half of the same claim: the FIRST ArrowLeft from the block end
  // must land OUTSIDE the code run, not inside it. This is the reported bug in one
  // assertion — before the arrival rung it produced `[{aaaX,code},{a}]`, a
  // `{code}`-marked character typed at a caret that is visually past the span.
  const p8b = await traversalBlock();
  await caretToEndOf(page, p8b);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  await page.keyboard.type("X", { delay: 25 });
  await snap(page, out, "8-arrive-leftward");
  {
    const runs = await settledRuns(page, pageId, p8b);
    r.ok(
      "P8 one ArrowLeft from the block end lands on the stop, OUTSIDE the mark",
      JSON.stringify(runs) ===
        JSON.stringify([
          { text: "aaa", marks: ["code"] },
          { text: "Xa", marks: [] },
        ]),
      `got ${JSON.stringify(runs)} — [{aaaX,code},{a}] is the pre-fix behavior: the press landed on ` +
        `the seam's \`natural\` anchor (inside the code run) and skipped the stop entirely`,
    );
  }

  // --- Phase 9: the MIRRORED seam — the marked run on the RIGHT --------------
  //
  // `` a`aaa` ``. Chromium biases the seam to the END of the earlier run just as
  // in phase 6, but here that run is the PLAIN one — so `natural` is `{}` and the
  // state the browser never produces is the one INSIDE the code run at its start.
  // Typing there PREPENDS into the span.
  //
  // This is the row the retired `left ∩ right` rule got wrong, and it got it
  // wrong in the most invisible way available: `L ∩ R = {}`, `natural = {}`, so
  // the rule concluded "the missing state is one the caret already has" and
  // synthesized NO stop. Nothing failed, nothing was skipped, the caret simply
  // could not be put inside a code run at its start — you could append to a code
  // span (phase 2) but never prepend to one. `L ∩ R` agrees with the real rule
  // exactly when the stop's own side is a SUBSET of `natural`'s, which is true of
  // every block edge and of phase 6's seam, i.e. of all 30 assertions above.

  /** A fresh `[{a},{aaa,code}]` block, caret parked AT the seam (linear 1). */
  const mirroredSeamBlock = async (label: string): Promise<string> => {
    const id = await enterNewBlock(page, pageId);
    // The backtick delimiter is intraword-legal (`INLINE_SYNTAXES`), so this
    // autoformats as one sequence — no separate typing step needed.
    await page.keyboard.type("a`aaa`", { delay: 25 });
    await page.waitForTimeout(TRANSFORM_MS);
    await caretToStartOf(page, id);
    // Offset 0 here is NOT a boundary (both sides unmarked), so this press count
    // is not the thing under test — but `pressUntilLinear` stops the moment it
    // reads 1 either way, so the fixture never spends the press phase 9b measures.
    const presses = await pressUntilLinear(page, "ArrowRight", 1);
    r.ok(
      `${label} the caret reached the a|\`aaa\` seam`,
      presses >= 0,
      `presses=${presses}`,
    );
    return id;
  };

  // (a) The baseline: no step. `natural` is the PLAIN run's `{}`, so the
  //     unstepped seam types outside the span — the mirror of 6a, and the probe
  //     that the left bias still holds in this orientation. If Chromium ever
  //     anchored the seam RIGHT instead, this would produce 9b's rows and the
  //     whole phase would be measuring nothing.
  const p9a = await mirroredSeamBlock("P9a");
  await page.keyboard.type("X", { delay: 25 });
  await snap(page, out, "9a-mirror-unstepped");
  r.eq(
    "P9a WITHOUT a step the mirrored seam types OUTSIDE the mark (natural = the plain run)",
    await settledRuns(page, pageId, p9a),
    [
      { text: "aX", marks: [] },
      { text: "aaa", marks: ["code"] },
    ],
  );

  // (b) THE new load-bearing assertion. One ArrowRight is absorbed by the stop,
  //     and typing there lands INSIDE the code run — a `{code}`-marked character
  //     appended to the existing code run, not a new plain one. Under the old
  //     rule this phase's press moved the caret and `X` came out plain.
  const p9b = await mirroredSeamBlock("P9b");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(200);
  r.eq(
    "P9b the stop absorbs the first ArrowRight (linear stays 1)",
    await caretLinear(page),
    1,
  );
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  await page.keyboard.type("X", { delay: 25 });
  await snap(page, out, "9b-mirror-stop");
  {
    const runs = await settledRuns(page, pageId, p9b);
    r.ok(
      "P9b typing AT the mirrored seam's stop PREPENDS into the code run",
      JSON.stringify(runs) ===
        JSON.stringify([
          { text: "a", marks: [] },
          { text: "Xaaa", marks: ["code"] },
        ]),
      `got ${JSON.stringify(runs)} — [{aX},{aaa,code}] means the stop carries \`natural\` instead of the ` +
        `far side's marks (the \`left ∩ right\` behavior: no stop at all); [{a},{aXaa,code}] means the ` +
        `press moved instead of being absorbed`,
    );
  }

  // (c) The second press crosses, one position INTO the code run.
  const p9c = await mirroredSeamBlock("P9c");
  await page.keyboard.press("ArrowRight"); // absorbed by the stop
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowRight"); // crosses
  await page.waitForTimeout(200);
  r.eq(
    "P9c a SECOND ArrowRight crosses the mirrored seam (linear 1 → 2)",
    await caretLinear(page),
    2,
  );
  await page.keyboard.type("X", { delay: 25 });
  await snap(page, out, "9c-mirror-crossed");
  r.eq(
    "P9c after crossing, the char lands one position INTO the code run",
    await settledRuns(page, pageId, p9c),
    [
      { text: "a", marks: [] },
      { text: "aXaa", marks: ["code"] },
    ],
  );

  // (d) Backspace at the mirrored stop deletes the delimiter — which here is the
  //     span's OPENER, so the strip walks FORWARD. The one-directional walk this
  //     replaced started at the anchor (in the plain run), found no `code` there,
  //     and stripped nothing at all: a Backspace consumed for no effect.
  const p9d = await mirroredSeamBlock("P9d");
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  await page.keyboard.press("Backspace");
  await snap(page, out, "9d-mirror-unmark");
  r.eq(
    "P9d Backspace at the mirrored stop strips the mark from the span AHEAD of the caret",
    await settledRuns(page, pageId, p9d),
    [{ text: "aaaa", marks: [] }],
  );
  {
    const codes = await markedTexts(page, p9d, "code");
    r.ok(
      "P9d the <code> is gone from the DOM too",
      codes.length === 0,
      JSON.stringify(codes),
    );
  }

  // (e) Traversal symmetry in this orientation. Same claim, same shape, and the
  //     one that would catch an arrival rung that only handles the seams whose
  //     stop lies right of `natural`. For `` a`aaa` ``:
  //
  //       rightward   0 1 1 2 3 4 4      (0 → 1 → 1* → 2 → 3 → 4 → 4*)
  //       leftward    4 4 3 2 1 1 0      (4* → 4 → 3 → 2 → 1* → 1 → 0)
  const p9e = await enterNewBlock(page, pageId);
  await page.keyboard.type("a`aaa`", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await enterNewBlock(page, pageId); // the rightward walk's exit block
  await caretToStartOf(page, p9e);
  const mirrorRight = await walk(p9e, "ArrowRight");
  r.eq(
    "P9e rightward visits every state in order",
    mirrorRight,
    [0, 1, 1, 2, 3, 4, 4],
  );
  // The rightward walk exited into the block below, so ONE ArrowLeft crosses back
  // — and phase 10's rule lands it on the block-END stop, the rightmost state of
  // all, which is where the leftward walk has to begin.
  //
  // Deliberately NOT `caretToEndOf` + ArrowRight, the phase-8 idiom: MEASURED, a
  // click past the end of a block whose last run is MARKED does not produce that
  // run's text-end anchor (it resolves to the paragraph element, which belongs to
  // neither side of the seam and correctly offers no stop — typing there is
  // already outside the span), so the ArrowRight left the block instead. Crossing
  // in goes through `placeCaretAtBoundary`, whose anchor is not a hit test.
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  r.eq(
    "P9e the crossing back in landed on the block-end stop",
    await caretBlockId(page),
    p9e,
  );
  const mirrorLeft = await walk(p9e, "ArrowLeft");
  r.eq(
    "P9e leftward visits the same states in reverse",
    mirrorLeft,
    [4, 4, 3, 2, 1, 1, 0],
  );
  r.eq(
    "P9e the two walks are exact mirror images",
    [...mirrorLeft].reverse(),
    mirrorRight,
  );

  // --- Phase 10: CROSS-BLOCK ARRIVAL -----------------------------------------
  //
  // A block's own edge can be a mark boundary, and a horizontal crossing INTO the
  // block must meet the seam's near state first — the same rule phase 8 pins for
  // a step within a block, one scope up. Before it, ArrowLeft out of the next
  // block landed INSIDE the previous block's trailing code run, so the stop the
  // caret would have stopped at walking rightwards to that same position was
  // unreachable from outside.
  //
  // The second half is the safety property: a CLICK at the same position must
  // NOT assert the stop. Nothing was crossed, so arming the `escaped` gate there
  // would make the next Backspace strip a whole span — the same class of bug the
  // stored depth exists to prevent, reintroduced through the landing path.
  const p10a = await enterNewBlock(page, pageId);
  await page.keyboard.type("hello `code`", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  const p10b = await enterNewBlock(page, pageId);
  await page.keyboard.type("world", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await caretToStartOf(page, p10b);
  await page.keyboard.press("ArrowLeft"); // crosses into p10a's end
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  r.eq(
    "P10 the crossing landed in the previous block",
    await caretBlockId(page),
    p10a,
  );
  r.eq("P10 ...at its very end", await caretLinear(page), 10);
  await page.keyboard.type("X", { delay: 25 });
  await snap(page, out, "10-cross-block-arrival");
  r.eq(
    "P10 one ArrowLeft into a block ending in a marked run lands OUTSIDE the mark",
    await settledRuns(page, pageId, p10a),
    [
      { text: "hello ", marks: [] },
      { text: "code", marks: ["code"] },
      { text: "X", marks: [] },
    ],
  );

  // The mirror: crossing RIGHTWARD into a block whose FIRST run is marked.
  const p10c = await enterNewBlock(page, pageId);
  await page.keyboard.type("prev", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  const p10d = await enterNewBlock(page, pageId);
  await page.keyboard.type("**bb**", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await page.keyboard.type(" tail", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await caretToEndOf(page, p10c);
  await page.keyboard.press("ArrowRight"); // crosses into p10d's start
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  r.eq(
    "P10 the rightward crossing landed in the next block",
    await caretBlockId(page),
    p10d,
  );
  r.eq("P10 ...at its very start", await caretLinear(page), 0);
  await page.keyboard.type("x", { delay: 25 });
  await snap(page, out, "10-cross-block-arrival-right");
  r.eq(
    "P10 one ArrowRight into a block STARTING with a marked run lands OUTSIDE the mark",
    await settledRuns(page, pageId, p10d),
    [
      { text: "x", marks: [] },
      { text: "bb", marks: ["bold"] },
      { text: " tail", marks: [] },
    ],
  );

  // A CLICK is not a crossing. `caretToStartOf` clicks the left edge and then
  // presses ArrowLeft only while the offset is above 0 — so it lands at offset 0
  // by click alone here, with no arrow press. The `escaped` gate must be shut, so
  // Backspace is the ordinary one: a MERGE into the previous block, not a strip.
  const p10e = await enterNewBlock(page, pageId);
  await page.keyboard.type("**cc**", { delay: 25 });
  await page.waitForTimeout(TRANSFORM_MS);
  await caretToStartOf(page, p10e);
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(OP_MS);
  {
    const ids = await editableIds(page);
    r.ok(
      "P10 a CLICK to the same position does not arm the gate — Backspace still MERGES",
      !ids.includes(p10e),
      JSON.stringify(ids.slice(-4)),
    );
  }

  // --- Phase 11: CROSSING AN INLINE DECORATOR --------------------------------
  //
  // The third way a caret can ARRIVE at a mark boundary, and the one this file
  // did not cover: not a step within a block (phases 1-9) and not a crossing from
  // an adjacent block (phase 10), but a crossing over an inline DECORATOR —
  // a `[[page]]` chip, a `@date` chip, a pasted image. Design:
  // research/2026-08-08-global-caret-crossing-channel.md.
  //
  // The defect it pins, stated as data: in `` `code`[chip] ``, ArrowLeft from the
  // end of the block landed INSIDE the code run, so the very next character typed
  // came out `{code}`-marked at a caret that is visually past the span. Phase 8
  // asserts exactly that claim one press away from a decorator, and passed —
  // which is the point. `decorator-nav` moves the caret with Lexical node APIs
  // (`selectPrevious()` / `selectNext(0, 0)`), and NO selection transition tells
  // the mark model that a crossing happened. Only the mover knows, so only the
  // mover can say so: `crossCaret` performs the move and announces it as one act,
  // and the page editor's arrival observer lands the stop.
  //
  // It cannot be generalised into the mark lookahead either, and that is worth
  // knowing before "simplifying" this away: `markArriveFor` works in the LINEAR
  // OFFSET basis, where a decorator occupies `tokenOf(node).length` characters
  // (`block-text-extensions.ts`), so "one caret step left" is NOT `offset - 1`
  // beside a chip — `$resolveLinearOffset(off - 1)` lands inside the chip and
  // correctly answers null. Announcement is the only mechanism that reaches
  // across a decorator.
  //
  // THE FIXTURE IS A PASTE, not typing. `decideTransfer` sends MULTI-LINE
  // `text/plain` through `parseMarkdownToForest` (so `[[<pageId>]]` is a
  // protected span that becomes a real chip node, and `` `code` `` becomes a
  // marked run); a SINGLE-line paste falls through to the native inline paste and
  // would leave a literal `[[…]]` token sitting in the text — a fixture that
  // looks right and crosses no decorator at all. Hence the trailing `sentinel`
  // line, which doubles as the block the rightward walk of 11e exits into.

  /** The inline page-link token for THIS page — a chip pointing at itself. */
  const CHIP = pageLinkToken(pageId);

  /**
   * Paste `lines` at the end of the document; the ids of the blocks it created,
   * in document order (one per line, which is what the count check pins).
   *
   * The wait for the pasted ROWS is the same doc-init gate `enterNewBlock`
   * documents, for the same reason: a block's content `Y.Doc` cannot seed until
   * its `page_blocks` row is confirmed, and every assertion below opens by typing
   * into one of these.
   */
  const pasteLines = async (
    label: string,
    lines: readonly string[],
  ): Promise<string[]> => {
    const host = await enterNewBlock(page, pageId);
    const before = await editableIds(page);
    await page.evaluate(
      (t) => navigator.clipboard.writeText(t),
      lines.join("\n"),
    );
    await editableOf(page, host).click();
    await page.waitForTimeout(200);
    await page.keyboard.press(PASTE);
    await page.waitForTimeout(1500);
    const after = await editableIds(page);
    const fresh = after.filter((id) => !before.includes(id));
    if (fresh.length !== lines.length) {
      throw new Error(
        `${label}: the paste produced ${fresh.length} blocks, expected ${lines.length} — ` +
          `${JSON.stringify({ before, after })}`,
      );
    }
    const deadline = Date.now() + 20_000;
    for (;;) {
      const rows = await fetchRows(pageId);
      if (fresh.every((id) => rows.has(id))) break;
      if (Date.now() > deadline)
        throw new Error(`${label}: pasted blocks never reached the server`);
      await page.waitForTimeout(250);
    }
    await page.waitForTimeout(800);
    return fresh;
  };

  /** How many inline decorator nodes Lexical rendered inside `blockId`. */
  const decoratorCount = async (blockId: string): Promise<number> =>
    page.evaluate(
      (id) =>
        document.querySelectorAll(
          `[data-block-id="${id}"] [data-lexical-decorator="true"]`,
        ).length,
      blockId,
    );

  /**
   * A fresh `` `code`[[page]] `` block followed by a `sentinel` block, with the
   * fixture's two load-bearing preconditions asserted.
   *
   * The chip check is not decoration: a `[[…]]` that stayed a literal token is a
   * plain text run, so every assertion in this phase would pass or fail for
   * reasons that have nothing to do with crossing a decorator.
   */
  const chipBlock = async (
    label: string,
  ): Promise<{ id: string; sentinel: string }> => {
    const [id, sentinel] = await pasteLines(label, [
      `\`code\`${CHIP}`,
      "sentinel",
    ]);
    if (!id || !sentinel) throw new Error(`${label}: fixture ids missing`);
    r.eq(
      `${label} the pasted fixture is [{code,code},{chip}]`,
      await settledRuns(page, pageId, id),
      [
        { text: "code", marks: ["code"] },
        { text: CHIP, marks: [] },
      ],
    );
    r.eq(
      `${label} the chip materialized as ONE inline decorator`,
      await decoratorCount(id),
      1,
    );
    return { id, sentinel };
  };

  /**
   * Park the caret at the very END of `id` — PAST the chip — by crossing in from
   * the block below, never by clicking.
   *
   * A click cannot be trusted here for two independent reasons. The chip is a
   * live control (clicking it navigates to the linked page), and its rendered
   * width is a page TITLE, so `caretToEndOf`'s "press ArrowRight until the linear
   * offset reads the block's text length" cannot tell the position before the
   * chip from the one after it when that title is empty. A crossing goes through
   * `placeCaretAtBoundary`, which is a model-level placement and not a hit test —
   * the same reason phase 9e crosses back in rather than clicking.
   */
  const parkPastChip = async (
    label: string,
    id: string,
    sentinel: string,
  ): Promise<void> => {
    await caretToStartOf(page, sentinel);
    await page.keyboard.press("ArrowLeft"); // crosses into `id`'s end
    await page.waitForTimeout(FORMAT_WINDOW_MS);
    r.eq(
      `${label} the caret is parked in the chip block`,
      await caretBlockId(page),
      id,
    );
    // The discriminator: standing after the chip, the anchor belongs to the
    // paragraph, NOT to the `<code>`. If this reads true the fixture already
    // failed and the assertion below would be measuring the wrong position.
    const insideCode = await caretInsideCode(page);
    r.ok(
      `${label} ...at its very end, past the chip (anchor is outside the <code>)`,
      insideCode === false,
      `caretInsideCode=${String(insideCode)}`,
    );
  };

  // (a) THE assertion. One ArrowLeft crosses the chip and must land on the
  //     boundary's stop — the state carrying the RIGHT side's (empty) marks —
  //     so the character typed there is plain and lands BETWEEN the code run and
  //     the chip.
  const p11a = await chipBlock("P11a");
  await parkPastChip("P11a", p11a.id, p11a.sentinel);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  await page.keyboard.type("X", { delay: 25 });
  await snap(page, out, "11a-cross-chip-leftward");
  {
    const runs = await settledRuns(page, pageId, p11a.id);
    r.ok(
      "P11a one ArrowLeft ACROSS the chip lands on the stop, OUTSIDE the mark",
      JSON.stringify(runs) ===
        JSON.stringify([
          { text: "code", marks: ["code"] },
          { text: `X${CHIP}`, marks: [] },
        ]),
      `got ${JSON.stringify(runs)} — [{codeX,code},{chip}] is the reported defect: the one ArrowLeft ` +
        `across the chip landed INSIDE the code run instead of at the boundary, so the character came ` +
        `out \`{code}\`-marked at a caret that is visually past the span`,
    );
  }

  // (b) The stop is ONE press, not a state the caret cannot leave. A second
  //     ArrowLeft is absorbed at the same offset and crosses back INSIDE the
  //     span, so `X` appends to the code run — the phase-2 claim, reached across
  //     a decorator.
  const p11b = await chipBlock("P11b");
  await parkPastChip("P11b", p11b.id, p11b.sentinel);
  await page.keyboard.press("ArrowLeft"); // onto the stop
  await page.waitForTimeout(200);
  await page.keyboard.press("ArrowLeft"); // back inside the code run
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  await page.keyboard.type("X", { delay: 25 });
  await snap(page, out, "11b-second-press-steps-in");
  {
    const runs = await settledRuns(page, pageId, p11b.id);
    r.ok(
      "P11b a SECOND ArrowLeft steps back INSIDE the code run",
      JSON.stringify(runs) ===
        JSON.stringify([
          { text: "codeX", marks: ["code"] },
          { text: CHIP, marks: [] },
        ]),
      `got ${JSON.stringify(runs)} — [{code,code},{X${CHIP}}] means the second press was absorbed too, ` +
        `i.e. the stop is a state the caret cannot leave leftward rather than a single caret position`,
    );
  }

  // (c) The rightward mirror, on `` [[page]]`code` ``. This assertion does DOUBLE
  //     DUTY, and both halves are needed for it to pass.
  //
  //     `decorator-nav` used to call `adjacent.selectNext()` with no arguments.
  //     `LexicalNode.selectNext` forwards them to `nextSibling.select(undefined,
  //     undefined)`, and `TextNode.select` DEFAULTS an undefined offset to
  //     `text.length` — so ArrowRight across a chip followed by text landed at
  //     the END of that whole run, silently skipping it. (`selectPrevious()` is
  //     correct by luck: its default IS the end of the previous node, which is
  //     the right leftward landing. `caret-geometry.ts` already passed (0, 0).)
  //
  //     With `(nextLeaf, 0)` the anchor is NOT coerced — the previous sibling is
  //     a decorator, so `resolveSelectionPointOnBoundary`'s `$isTextNode`
  //     coercion does not fire (see `web/__tests__/lexical-boundary-invariant.test.tsx`)
  //     — and the announcement lands the caret OUTSIDE the code run that follows
  //     the chip. So `X` must appear at the code run's START and unmarked: one
  //     claim about WHERE the press landed, one about WHICH state it landed in.
  const [p11cPrev, p11cId] = await pasteLines("P11c", [
    "sentinel",
    `${CHIP}\`code\``,
  ]);
  if (!p11cPrev || !p11cId) throw new Error("P11c: fixture ids missing");
  r.eq(
    "P11c the pasted mirror fixture is [{chip},{code,code}]",
    await settledRuns(page, pageId, p11cId),
    [
      { text: CHIP, marks: [] },
      { text: "code", marks: ["code"] },
    ],
  );
  r.eq(
    "P11c the chip materialized as ONE inline decorator",
    await decoratorCount(p11cId),
    1,
  );
  await caretToEndOf(page, p11cPrev);
  await page.keyboard.press("ArrowRight"); // crosses into the chip block's start
  await page.waitForTimeout(200);
  r.eq(
    "P11c the crossing landed in the chip block",
    await caretBlockId(page),
    p11cId,
  );
  await page.keyboard.press("ArrowRight"); // crosses the chip
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  await page.keyboard.type("X", { delay: 25 });
  await snap(page, out, "11c-cross-chip-rightward");
  {
    const runs = await settledRuns(page, pageId, p11cId);
    r.ok(
      "P11c one ArrowRight ACROSS the chip lands at the code run's START, outside the mark",
      JSON.stringify(runs) ===
        JSON.stringify([
          { text: `${CHIP}X`, marks: [] },
          { text: "code", marks: ["code"] },
        ]),
      `got ${JSON.stringify(runs)} — anything putting X at the END of the run ([{chip},{codeX,code}] or ` +
        `[{chip},{code,code},{X}]) is the argument-less \`selectNext()\`: the caret skipped the whole ` +
        `run. [{chip},{Xcode,code}] means it landed at the start but on \`natural\`, i.e. the crossing ` +
        `was never announced`,
    );
  }

  // (d) Backspace at the 11a stop. Nothing exercised this before: the stop's
  //     other side is a DECORATOR, so `$scanMarkSpan` is being handed an anchor
  //     whose neighbouring leaf is not text. It needs no new code — the stop is
  //     `(codeLeaf, len)`, a text anchor, `delimiterDeletion` gives
  //     `before={code}, after={}`, `$leafMarks` already answers `[]` for a
  //     decorator and `$stripMarkSpan` already stops at one — but "needs no new
  //     code" is a claim, and this is the assertion that makes it one.
  //
  //     The stripped run and the chip's own token run are then BOTH unmarked and
  //     adjacent, so `mergeRuns` folds them into one — which is why the expected
  //     rows are a single run rather than two.
  const p11d = await chipBlock("P11d");
  await parkPastChip("P11d", p11d.id, p11d.sentinel);
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(FORMAT_WINDOW_MS);
  await page.keyboard.press("Backspace");
  await snap(page, out, "11d-strip-beside-decorator");
  r.eq(
    "P11d Backspace at the stop strips the mark from a span whose neighbour is a decorator",
    await settledRuns(page, pageId, p11d.id),
    [{ text: `code${CHIP}`, marks: [] }],
  );
  {
    const codes = await markedTexts(page, p11d.id, "code");
    r.ok(
      "P11d the <code> is gone from the DOM too",
      codes.length === 0,
      JSON.stringify(codes),
    );
  }
  r.eq(
    "P11d ...and the chip survived the strip",
    await decoratorCount(p11d.id),
    1,
  );

  // (e) TRAVERSAL SYMMETRY across the chip block — the phase 8 / 9e shape, and
  //     the assertion that catches a stop skipped on exactly ONE approach, which
  //     is the shape this whole defect had (phase 8's leftward walk is what
  //     caught the within-block version of it).
  //
  //     One thing differs from phases 8 and 9e: the last offset is not a literal.
  //     `caretLinear` measures RENDERED text, and a chip renders the linked
  //     page's TITLE, whose width this script does not control (the model's own
  //     linear basis counts `tokenOf(node).length` instead — a different number
  //     again). So the walk's interior — the code run and its single stop at the
  //     chip boundary — is pinned literally, and the exit offset is pinned only
  //     by the mirror, which is the claim that actually matters:
  //
  //       rightward   0 0 1 2 3 4 4 E      (0* → 0 → 1 → 2 → 3 → 4 → 4* → past the chip)
  //       leftward    E 4 4 3 2 1 0 0
  const p11e = await chipBlock("P11e");
  await caretToStartOf(page, p11e.id);
  // One more ArrowLeft to reach the block-START stop, the leftmost state of all —
  // the same opening phase 8 uses, and what makes the two walks cover one state set.
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  const chipRight = await walk(p11e.id, "ArrowRight");
  r.note(`P11e rightward offsets: ${JSON.stringify(chipRight)}`);
  r.eq(
    "P11e rightward crosses the code run and stops ONCE at the chip boundary",
    chipRight.slice(0, 7),
    [0, 0, 1, 2, 3, 4, 4],
  );
  r.ok(
    "P11e ...then one press crosses the chip and one more leaves the block",
    chipRight.length === 8,
    JSON.stringify(chipRight),
  );
  // The rightward walk exited into the `sentinel` block below, so ONE ArrowLeft
  // crosses back — landing at the block END (past the chip), which is where the
  // leftward walk has to begin. Same idiom as phase 9e, and for the same reason:
  // a crossing is a model-level placement, a click is a hit test.
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(200);
  r.eq(
    "P11e the crossing back in landed in the chip block",
    await caretBlockId(page),
    p11e.id,
  );
  const chipLeft = await walk(p11e.id, "ArrowLeft");
  r.note(`P11e leftward offsets: ${JSON.stringify(chipLeft)}`);
  r.eq(
    "P11e the two walks are exact mirror images",
    [...chipLeft].reverse(),
    chipRight,
  );

  await page.waitForTimeout(2000); // let every doc flush land before the cold read

  // --- Phase 7: convergence in a second context ------------------------------
  // The marks — and the UNMARKED runs the steps produced — must live in each
  // block's `Y.Doc` (and its `data.text` projection), not only in tab A's Lexical
  // state. A cold load with a fresh socket is the only read that proves it.
  const { page: pageB } = await h.session({ label: "B" });
  await pageB.goto(pageUrl, { waitUntil: "domcontentloaded" });
  // NOT `networkidle`: the app holds a notifications WebSocket open, so it never
  // settles. Wait on the block instead, then give hydration a beat.
  await editableOf(pageB, p1).waitFor({ state: "visible", timeout: 30_000 });
  await pageB.waitForTimeout(5000);
  await snap(pageB, out, "7-context-b");
  {
    const p1Text = await blockText(editableOf(pageB, p1));
    const p5Text = await blockText(editableOf(pageB, p5));
    r.eq(
      "P7 context B renders <code>zz</code> with 'x' outside it",
      await markedTexts(pageB, p1, "code"),
      ["zz"],
    );
    r.ok("P7 context B shows 'zzx'", p1Text === "zzx", JSON.stringify(p1Text));
    r.eq(
      "P7 context B renders <strong>bb</strong> with 'x' before it",
      await markedTexts(pageB, p5, "strong"),
      ["bb"],
    );
    r.ok(
      "P7 context B shows 'xbb tail'",
      p5Text === "xbb tail",
      JSON.stringify(p5Text),
    );
  }

  console.log("PAGE_URL:", pageUrl);
  console.log(
    "IDS:",
    JSON.stringify({
      p1,
      p2,
      p3,
      p4a,
      p4b,
      p4c: p4c1,
      p5,
      p6a,
      p6b,
      p6c,
      p8,
      p8b,
      p11a: p11a.id,
      p11b: p11b.id,
      p11c: p11cId,
      p11d: p11d.id,
      p11e: p11e.id,
    }),
  );

  await r.finish();
});
