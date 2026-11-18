// Inline markdown formatting shortcuts verification
// (research/2026-07-30-page-inline-markdown-shortcuts.md, "Verification" §4).
//
// Typing `**x**` bolds `x` and drops the delimiters; same for `__x__`, `*x*`,
// `_x_`, `***x***`, `___x___`, `~~x~~` and `` `x` ``. Underline declares no
// syntax (markdown has none), so it is deliberately absent from the table and
// from this script.
//
// Assertions run against the PERSISTED ROWS (`GET /api/pages/:pageId/blocks`)
// wherever the claim is about the data model — that is the only thing that
// proves the marks travelled Lexical → the block's `Y.Doc` → the ~1s
// `data.text` projection. A DOM-only read would pass on a mark that never left
// the browser. Where the claim is about RENDERING (`theme.text` mapping), the
// DOM is asserted instead: Lexical materializes bold as `<strong>` and italic
// as `<em>`.
//
// Phases:
//  1. every syntax row, one block each — exactly one run, expected text,
//     canonically sorted marks, no surviving delimiter char; plus `<strong>` /
//     `<em>` in the DOM;
//  2. the mark is OFF for text typed next, and the caret landed after the
//     content: `**b**` then ` tail` → [{b,bold},{ tail}]. THE load-bearing
//     assertion — see the long comment on that phase;
//  3. THE undo requirement: `**again**`, ONE Cmd+Z → literal `**again**` back
//     and NO re-fire (re-asserted after a wait), undo on to empty, then redo
//     back to the literal and one more redo to bold — exactly one `<strong>`;
//  4. no merge into the format undo item: `**x**` then ` more`, undo the
//     trailing typing → `x` still bold, no delimiter ever reappears;
//  5. negatives stay literal (`snake_case_name`, `a ** b **`, `**`);
//  6. the BLOCK-level ` ``` ` code fence is still reachable (the inline `` ` ``
//     row's non-empty-content rule did not steal the third backtick);
//  7. convergence in a second browser context (cold load, fresh socket).
//
// Usage: bun plugins/page/plugins/editor/e2e/inline-format-verify.ts [--url <deploy>] [--out /tmp/inline-fmt]
import {
  agentFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import type { Page } from "playwright";
import { blockText, caretState, openBlankPage } from "./support/blank-page";

const out = arg("out", "/tmp/inline-fmt");

const r = report();

// `mod+z` / `mod+shift+z` are the surface-level bindings (one
// `useUndoRedoShortcuts` per tab, in apps-core/tab-surface), where `mod` is
// Meta on macOS and Control elsewhere. The sibling scripts hardcode `Meta+z`
// because they were written on a Mac; Playwright's `ControlOrMeta` is the same
// key there and the correct one everywhere else, so this script uses it.
const UNDO = "ControlOrMeta+z";
const REDO = "ControlOrMeta+Shift+z";

// --- persisted-row reads ------------------------------------------------------

/** A run exactly as `data.text` stores it — `marks` is absent when empty. */
interface StoredRun {
  text: string;
  marks?: string[];
  color?: string;
  link?: string;
}
interface BlockRow {
  id: string;
  type: string;
  data?: { text?: StoredRun[] } | null;
}
/** The shape the assertions compare, so an absent `marks` reads as `[]`. */
interface NormRun {
  text: string;
  marks: string[];
}

async function fetchRows(pageId: string): Promise<Map<string, BlockRow>> {
  const res = await agentFetch(`/api/pages/${pageId}/blocks`);
  if (!res.ok) throw new Error(`blocks fetch ${res.status}`);
  const rows = (await res.json()) as BlockRow[];
  return new Map(
    rows.filter((row) => row.type !== "page").map((row) => [row.id, row]),
  );
}

/**
 * A row's runs, normalized to `{text, marks}`.
 *
 * `report.eq` compares by `JSON.stringify`, so key ORDER would otherwise be
 * part of the assertion — normalizing here keeps the expected literals honest
 * (and `marks: []` an explicit claim rather than a missing key).
 */
const runsOf = (row: BlockRow | undefined): NormRun[] =>
  (row?.data?.text ?? []).map((run) => ({
    text: run.text,
    marks: run.marks ?? [],
  }));

const textOfRuns = (runs: NormRun[]): string =>
  runs.map((run) => run.text).join("");

// --- DOM reads ----------------------------------------------------------------

/** Every editable block id in document order (a code block has none — see §6). */
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
 * The text of every `<tag>` Lexical rendered inside a block — the DOM proof of
 * the `theme.text` mapping. NBSP is normalized because Chromium renders a
 * model-level space as one at a text-node edge.
 */
async function markedTexts(
  page: Page,
  blockId: string,
  tag: string,
): Promise<string[]> {
  return page.evaluate(
    ([id, sel]) =>
      [...document.querySelectorAll(`[data-block-id="${id}"] ${sel}`)].map(
        (el) => (el.textContent ?? "").replace(/ /g, " "),
      ),
    [blockId, tag] as [string, string],
  );
}

// --- authoring helpers --------------------------------------------------------

/**
 * Enter at the end of the last block → one fresh empty block below, whose id is
 * returned.
 *
 * It diffs the id sets rather than assuming "the new block is last": every
 * phase here types at the end of the document, so it always IS last, but a
 * silent mis-identification would attribute the next phase's assertions to the
 * wrong row. Throwing is the loud failure.
 *
 * It then waits for the new block's ROW to exist server-side, which is not
 * padding but the doc-init gate itself: a freshly split block mounts its editor
 * from the optimistic overlay BEFORE the structural POST creates its
 * `page_blocks` row, and its content `Y.Doc` cannot seed until that row is
 * confirmed (`rowTruth === "present"` lifts the FK gate in
 * `use-collab-block-doc.ts`). Typing into that gap races the seed. Two failures
 * observed while this was a blind 700ms sleep, both on a loaded host where the
 * app's own monitor reported `element page-block-doc … took 2705ms`: `**`
 * persisting as a single `*` (a lost keystroke), and `` `c` `` persisting as
 * `c` + a leftover `` ` `` (a merge re-inserting a character the transform had
 * deleted). Those are pre-existing doc-init races, unrelated to inline
 * markdown; waiting on the real signal keeps the spec's SETUP out of them
 * instead of hiding them — a recurrence still surfaces loudly as a phase-1/5
 * text mismatch.
 */
async function enterNewBlock(page: Page, pageId: string): Promise<string> {
  const before = await editableIds(page);
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
  // The row is confirmed, so doc-init is now unblocked; give its round trip a
  // beat before the first keystroke.
  await page.waitForTimeout(800);
  return id;
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "A" });

  const {
    pageUrl,
    pageId,
    blockId: firstId,
  } = await openBlankPage(page, {
    settleMs: 3000,
  });
  console.log("page url:", pageUrl);
  console.log("PAGE_ID:", pageId);

  // --- Phase 1: every syntax row ---------------------------------------------
  // One block per row (Enter between), then ONE settled read of the persisted
  // rows for the lot — the projection debounce is ~1s, so batching the reads
  // costs one wait instead of eight.
  const syntaxRows: { typed: string; expected: NormRun[] }[] = [
    { typed: "**b**", expected: [{ text: "b", marks: ["bold"] }] },
    { typed: "__b2__", expected: [{ text: "b2", marks: ["bold"] }] },
    { typed: "*i*", expected: [{ text: "i", marks: ["italic"] }] },
    { typed: "_i2_", expected: [{ text: "i2", marks: ["italic"] }] },
    // `MARK_ORDER` is bold → italic → underline → strikethrough → code, so
    // these two are the canonical-sort assertion: `["bold","italic"]`, never
    // the table's declaration order reversed.
    {
      typed: "***bi***",
      expected: [{ text: "bi", marks: ["bold", "italic"] }],
    },
    {
      typed: "___bi2___",
      expected: [{ text: "bi2", marks: ["bold", "italic"] }],
    },
    { typed: "~~s~~", expected: [{ text: "s", marks: ["strikethrough"] }] },
    { typed: "`c`", expected: [{ text: "c", marks: ["code"] }] },
  ];

  const syntaxIds: string[] = [];
  for (const [i, row] of syntaxRows.entries()) {
    const id = i === 0 ? firstId : await enterNewBlock(page, pageId);
    syntaxIds.push(id);
    await page.keyboard.type(row.typed, { delay: 25 });
    // The transform runs in a `queueMicrotask` off the update listener, then the
    // collab binding flushes (~300ms debounce). Settle before the next Enter so
    // the split can never race a half-applied transform.
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(2500); // doc flush + ~1s `data.text` projection
  await snap(page, out, "1-syntax-rows");

  {
    const rows = await fetchRows(pageId);
    for (const [i, row] of syntaxRows.entries()) {
      const id = syntaxIds[i]!;
      r.eq(`P1 ${row.typed} → runs`, runsOf(rows.get(id)), row.expected);
    }
    // No delimiter char survives ANYWHERE in the transformed rows — the
    // aggregate form of "the delimiters were removed", which a per-row equality
    // could still pass if one row silently kept a stray char in a second run.
    const allText = syntaxIds
      .map((id) => textOfRuns(runsOf(rows.get(id))))
      .join("|");
    r.ok(
      "P1 no delimiter char survives in any row",
      !/[*_~`]/.test(allText),
      JSON.stringify(allText),
    );
  }

  // The DOM half: the model carrying `marks` proves nothing about rendering.
  // Bold's inner tag is `<strong>` and italic's `<em>` (Lexical's
  // `getElementInnerTag`), so these two rows prove the `theme.text` mapping is
  // actually wired for the marks the transform sets.
  {
    const strongs = await markedTexts(page, syntaxIds[0]!, "strong");
    r.eq("P1 **b** renders <strong>b</strong>", strongs, ["b"]);
    const ems = await markedTexts(page, syntaxIds[2]!, "em");
    r.eq("P1 *i* renders <em>i</em>", ems, ["i"]);
  }

  // --- Phase 2: the mark is OFF for text typed next --------------------------
  //
  // THE highest-value assertion in this file. `applyInlineFormat` restores the
  // caret's PRE-transform typing style (`selection.setFormat(preFormat)`, 0 in
  // the ordinary case) instead of inheriting the content node's new bold — and
  // that survives the DOM round trip only through Lexical's
  // `markCollapsedSelectionFormat`, a ~200ms window keyed on (anchor key,
  // offset). It is a timing window, not an invariant, so this is the only thing
  // that would catch a regression. Do not weaken it.
  //
  // It runs in a FRESH block typed CONTIGUOUSLY rather than by re-focusing
  // phase 1's `**b**` block, and that is load-bearing: a click-created collapsed
  // selection re-derives its format from the anchor node (Lexical's
  // `$updateSelectionFormatStyleFromTextNode`), so typing at the end of an
  // already-bold node is bold by design. Testing there would assert something
  // the implementation never claimed. "The text typed NEXT" means next.
  const tailId = await enterNewBlock(page, pageId);
  await page.keyboard.type("**b**", { delay: 25 });
  // Long enough for the microtask transform + its reconcile to land, short
  // enough that ` tail` really is the next thing typed.
  await page.waitForTimeout(300);
  const tailCaret = await caretState(editableOf(page, tailId));
  console.log("P2 caret after transform:", JSON.stringify(tailCaret));
  await page.keyboard.type(" tail", { delay: 25 });
  await page.waitForTimeout(2500);
  await snap(page, out, "2-mark-off");
  {
    const rows = await fetchRows(pageId);
    r.eq("P2 mark is OFF for text typed next", runsOf(rows.get(tailId)), [
      { text: "b", marks: ["bold"] },
      { text: " tail", marks: [] },
    ]);
    // The DOM dual: ` tail` sits OUTSIDE the `<strong>`, which is also the proof
    // the caret landed AFTER the content rather than inside it or before it.
    const strongs = await markedTexts(page, tailId, "strong");
    r.eq(
      "P2 <strong> holds only 'b' (caret landed after the content)",
      strongs,
      ["b"],
    );
    const visible = await blockText(editableOf(page, tailId));
    r.ok(
      "P2 visible text is 'b tail'",
      visible === "b tail",
      JSON.stringify(visible),
    );
  }

  // --- Phase 3: THE undo requirement -----------------------------------------
  const undoId = await enterNewBlock(page, pageId);
  await page.keyboard.type("**again**", { delay: 25 });
  await page.waitForTimeout(700);
  {
    const strongs = await markedTexts(page, undoId, "strong");
    const visible = await blockText(editableOf(page, undoId));
    r.ok(
      "P3 **again** bolded",
      visible === "again" &&
        JSON.stringify(strongs) === JSON.stringify(["again"]),
      `text=${JSON.stringify(visible)} strong=${JSON.stringify(strongs)}`,
    );
  }

  // Cmd+Z #1 pops the `Format text` entry only: the literal delimiters come
  // back, the mark goes away. This is the requirement the whole design exists
  // for — a user who wanted real asterisks keeps them.
  await page.keyboard.press(UNDO);
  await page.waitForTimeout(700);
  await snap(page, out, "3-undo-format");
  {
    const visible = await blockText(editableOf(page, undoId));
    const strongs = await markedTexts(page, undoId, "strong");
    r.ok(
      "P3 undo restores the literal '**again**'",
      visible === "**again**",
      JSON.stringify(visible),
    );
    r.ok(
      "P3 undo leaves no <strong>",
      strongs.length === 0,
      JSON.stringify(strongs),
    );
  }

  // NO RE-FIRE. The restored text still ENDS in `**`, so a transform that did
  // not drop `HISTORIC_TAG` would re-bold it — asynchronously, a beat later.
  // Re-reading after a wait is the only way to see that.
  await page.waitForTimeout(600);
  {
    const visible = await blockText(editableOf(page, undoId));
    const strongs = await markedTexts(page, undoId, "strong");
    r.ok(
      "P3 no re-fire: still literal after a settle",
      visible === "**again**",
      JSON.stringify(visible),
    );
    r.ok(
      "P3 no re-fire: still no <strong>",
      strongs.length === 0,
      JSON.stringify(strongs),
    );
  }

  // Undoing PAST the format entry reaches the typing behind it and empties the
  // block. It must not reach the Enter that created the block, which is a
  // separate entry we never pop.
  //
  // The number of presses that takes is the run tracker's idle-window (500ms)
  // granularity, NOT something this feature specifies:
  // one press in a quiet run, but a >500ms gap between two keystrokes of
  // `**again**` splits the typing into several items (observed on a loaded host:
  // one press left `"**a"`). So press until empty, bounded, and report the count
  // — hardcoding "exactly one" would make an unrelated timing mechanism
  // masquerade as an inline-markdown regression. What IS asserted here, and what
  // a merged format item would break, is that bold never comes back on the way
  // down.
  // Each entry is `<visible text>/<number of <strong>s>` after one press.
  const undoStates: string[] = [];
  let typingUndos = 0;
  while (
    (await blockText(editableOf(page, undoId))) !== "" &&
    typingUndos < 4
  ) {
    await page.keyboard.press(UNDO);
    await page.waitForTimeout(800);
    typingUndos += 1;
    const visible = await blockText(editableOf(page, undoId));
    undoStates.push(
      `${visible}/${(await markedTexts(page, undoId, "strong")).length}`,
    );
  }
  r.note(
    `P3 the typing run occupied ${typingUndos} undo entr${typingUndos === 1 ? "y" : "ies"}`,
  );
  {
    const visible = await blockText(editableOf(page, undoId));
    r.ok(
      "P3 undoing past the format empties the block",
      visible === "",
      JSON.stringify(visible),
    );
    r.ok(
      "P3 bold never returned while undoing the typing",
      undoStates.every((state) => state.endsWith("/0")),
      JSON.stringify(undoStates),
    );
    const ids = await editableIds(page);
    r.ok(
      "P3 undoing the typing did not delete the block",
      ids.includes(undoId),
      JSON.stringify(ids),
    );
  }

  // Redo the same number of typing entries → back to the literal, still unbolded.
  for (let i = 0; i < typingUndos; i++) {
    await page.keyboard.press(REDO);
    await page.waitForTimeout(800);
  }
  {
    const visible = await blockText(editableOf(page, undoId));
    const strongs = await markedTexts(page, undoId, "strong");
    r.ok(
      "P3 redo #1 restores the literal '**again**'",
      visible === "**again**",
      JSON.stringify(visible),
    );
    r.ok(
      "P3 redo #1 leaves no <strong>",
      strongs.length === 0,
      JSON.stringify(strongs),
    );
  }

  await page.keyboard.press(REDO);
  await page.waitForTimeout(800);
  await snap(page, out, "3-redo-format");
  {
    const visible = await blockText(editableOf(page, undoId));
    const strongs = await markedTexts(page, undoId, "strong");
    // "exactly one" is the no-re-fire check on the redo side: a second
    // application would split the run and leave two `<strong>`s (or re-strip
    // nothing and leave the text wrong).
    r.ok(
      "P3 redo #2 re-applies bold",
      visible === "again",
      JSON.stringify(visible),
    );
    r.eq("P3 redo #2 leaves exactly one <strong>", strongs, ["again"]);
  }

  // --- Phase 4: no merge into the format undo item ---------------------------
  // `recordDocEdit` records the format as its own data entry and the run
  // tracker's `untracked` scope closes around it, so typing straight after
  // starts a fresh run and a later Cmd+Z removes only that typing — never the
  // format.
  const mergeId = await enterNewBlock(page, pageId);
  await page.keyboard.type("**x**", { delay: 25 });
  await page.waitForTimeout(300);
  // Typed as one fast burst for the same `captureTimeout` reason as phase 3.
  await page.keyboard.type(" more", { delay: 0 });
  await page.waitForTimeout(800);
  {
    const visible = await blockText(editableOf(page, mergeId));
    r.ok("P4 composed 'x more'", visible === "x more", JSON.stringify(visible));
  }
  // Undo the trailing typing — one press in a quiet run, more if the idle
  // window split it (phase 3's note). The claim is not the press count:
  // it is that the trailing typing peels off WITHOUT the format, so the text
  // lands on `x` and no state on the way there has a delimiter in it. Had the
  // format merged into the typing item, `**x**` would appear instead.
  const mergeStates: string[] = [];
  let tailUndos = 0;
  while (
    (await blockText(editableOf(page, mergeId))) !== "x" &&
    tailUndos < 4
  ) {
    await page.keyboard.press(UNDO);
    await page.waitForTimeout(800);
    tailUndos += 1;
    mergeStates.push(await blockText(editableOf(page, mergeId)));
  }
  await snap(page, out, "4-no-merge");
  r.note(
    `P4 the trailing typing occupied ${tailUndos} undo entr${tailUndos === 1 ? "y" : "ies"}`,
  );
  {
    const visible = await blockText(editableOf(page, mergeId));
    const strongs = await markedTexts(page, mergeId, "strong");
    r.ok(
      "P4 undoing the trailing typing lands on 'x'",
      visible === "x",
      JSON.stringify(visible),
    );
    r.ok(
      "P4 the format never reverted (no delimiter reappeared)",
      mergeStates.every((state) => !state.includes("*")),
      JSON.stringify(mergeStates),
    );
    r.eq("P4 'x' is still bold after that undo", strongs, ["x"]);
  }

  // --- Phase 5: negatives stay literal ---------------------------------------
  // `snake_case_name` — the `_` family's intraword rule; `a ** b **` —
  // whitespace flanking the delimiters; `**` — the non-empty-content rule, which
  // is what makes `**` typable at all.
  const negatives = ["snake_case_name", "a ** b **", "**"];
  const negativeIds: string[] = [];
  for (const typed of negatives) {
    const id = await enterNewBlock(page, pageId);
    negativeIds.push(id);
    await page.keyboard.type(typed, { delay: 25 });
    await page.waitForTimeout(500);
    // Read the editor before the row, so a mismatch names its own cause: text
    // missing HERE means the keystrokes never reached the model (the doc-init
    // race in `enterNewBlock`'s comment), whereas text present here but wrong in
    // the row below would be a transform or projection fault.
    const visible = await blockText(editableOf(page, id));
    r.ok(
      `P5 ${JSON.stringify(typed)} reached the editor verbatim`,
      visible === typed,
      JSON.stringify(visible),
    );
  }
  await page.waitForTimeout(2500);
  await snap(page, out, "5-negatives");
  {
    const rows = await fetchRows(pageId);
    for (const [i, typed] of negatives.entries()) {
      r.eq(
        `P5 ${JSON.stringify(typed)} stays literal`,
        runsOf(rows.get(negativeIds[i]!)),
        [{ text: typed, marks: [] }],
      );
    }
  }

  // --- Phase 6: the block-level code fence is still reachable ----------------
  // Rule 5 (strict non-empty content) is what keeps the inline `` ` `` row from
  // claiming the third backtick of ` ``` `. Last DOM-mutating phase on purpose:
  // the converted block renders a textarea over a shiki underlay, so it drops
  // out of `editableIds()` and takes the caret with it.
  //
  // Deliberately NO `snap()` here. `page.screenshot()` awaits
  // `document.fonts.ready`, and in the beat right after this conversion that
  // promise can stay pending past the harness's 30s screenshot timeout — one
  // observed run threw there with all 31 preceding assertions green. A cosmetic
  // capture must never be able to abort a spec, and the state is not lost: the
  // phase-7 context-B shot is a full-page view of this same code block, taken
  // once the page has settled.
  const fenceId = await enterNewBlock(page, pageId);
  await page.keyboard.type("```", { delay: 40 });
  await page.waitForTimeout(2500);
  {
    const rows = await fetchRows(pageId);
    const type = rows.get(fenceId)?.type;
    r.ok(
      "P6 ``` still converts the block to a code block",
      type === "code-block",
      `type=${type}`,
    );
  }

  await page.waitForTimeout(2000); // let every doc flush land before the cold read

  // --- Phase 7: convergence in a second context -----------------------------
  // The marks must live in each block's `Y.Doc` (and its `data.text`
  // projection), not only in tab A's Lexical state.
  const { page: pageB } = await h.session({ label: "B" });
  await pageB.goto(pageUrl, { waitUntil: "domcontentloaded" });
  // NOT `networkidle`: the app holds a notifications WebSocket open, so it never
  // settles. Wait on the block instead, then give hydration a beat.
  await editableOf(pageB, syntaxIds[0]!).waitFor({
    state: "visible",
    timeout: 30_000,
  });
  await pageB.waitForTimeout(5000);
  await snap(pageB, out, "7-context-b");
  {
    const strongs = await markedTexts(pageB, syntaxIds[0]!, "strong");
    const ems = await markedTexts(pageB, syntaxIds[2]!, "em");
    r.eq("P7 context B renders <strong>b</strong>", strongs, ["b"]);
    r.eq("P7 context B renders <em>i</em>", ems, ["i"]);
  }

  console.log("PAGE_URL:", pageUrl);
  console.log("SYNTAX_IDS:", JSON.stringify(syntaxIds));
  console.log(
    "TAIL_ID:",
    tailId,
    "UNDO_ID:",
    undoId,
    "MERGE_ID:",
    mergeId,
    "FENCE_ID:",
    fenceId,
  );

  await r.finish();
});
