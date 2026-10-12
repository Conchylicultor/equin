/**
 * Pure unit tests for the single keystroke intent step (`resolveKeystroke`).
 * Run with `bun test plugins/page/plugins/editor/`.
 *
 * This module is the one place that maps (keystroke, caret, block context) → op,
 * so these tests pin every decision that used to be scattered across the keyboard
 * plugin and the block API: split-asChild, merge-vs-outdent, indent/outdent
 * boundary no-ops, and when an arrow crosses blocks vs. moves within one.
 */

import { test, expect, describe } from "bun:test";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  applyBlockOp,
  nextVisibleLine,
  type BlockNode,
  type Mark,
} from "../../core";
import {
  resolveKeystroke,
  resolveTab,
  type IntentContext,
  type KeystrokeKey,
} from "./keystroke-intent";
import type { CaretContext } from "./caret-geometry";
import { scopeNodes } from "./zoom-scope";
import type { MarkBoundary } from "./mark-boundary";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PAGE = "page";
const rankA = Rank.between(null, null).toJSON();
const rankB = Rank.between(Rank.from(rankA), null).toJSON();
const rankChild = Rank.between(null, null).toJSON();

function mk(
  id: string,
  parentId: string | null,
  rank: string,
  opts: { text?: string; expanded?: boolean } = {},
): BlockNode {
  return {
    id,
    pageId: PAGE,
    parentId,
    type: "text",
    data: { text: opts.text ?? "" },
    rank,
    expanded: opts.expanded ?? false,
  };
}

/**
 * Page tree:
 *   page
 *   ├─ A ("hello", expanded, has child A1)
 *   │  └─ A1 (indented)
 *   └─ B
 */
function tree(): BlockNode[] {
  return [
    mk("A", PAGE, rankA, { text: "hello", expanded: true }),
    mk("A1", "A", rankChild),
    mk("B", PAGE, rankB),
  ];
}

/**
 * The block-TYPE facts the resolver takes as input, standing in for the block
 * handle registry the consumer resolves them from. The resolver never names a
 * type, so these fixtures ARE the registry for these specs:
 *
 * - `acceptsText` is false for every void schema — the page shell row, a
 *   container anchor, and a divider alike. It replaced two hardcoded
 *   `PAGE_BLOCK_TYPE` comparisons, so the page-boundary specs below are
 *   re-expressed through it with byte-identical outcomes, and the anchor/divider
 *   cases are the same rung reached by the types that used to fall through it.
 * - `isAnchor` marks the container types (here: `callout`).
 */
const VOID_TYPES = new Set(["page", "callout", "divider"]);
const ANCHOR_TYPES = new Set(["callout"]);
/** The same anchor set as the reducer's `BlockOpContext` (trajectory replay). */
const ANCHOR_CTX = { anchorTypes: ANCHOR_TYPES };
const TYPE_FACTS = {
  acceptsText: (n: BlockNode) => !VOID_TYPES.has(n.type),
  isAnchor: (n: BlockNode) => ANCHOR_TYPES.has(n.type),
  // Not a type fact, but carried beside them for the same reason: every spec
  // here resolves on the whole page unless it says otherwise (see "zoomed").
  scopeRootId: null,
};

function ctx(
  blockId: string,
  over: Partial<IntentContext> = {},
): IntentContext {
  return { nodes: tree(), blockId, ...TYPE_FACTS, ...over };
}

function caret(over: Partial<CaretContext> = {}): CaretContext {
  const base = {
    offset: 0,
    collapsed: true,
    atStart: false,
    atEnd: false,
    length: 5,
    onTopLine: false,
    onBottomLine: false,
    caretX: 0,
    // No mark boundary and depth 0 — the state every caret in this file is in
    // unless a spec says otherwise, so the whole existing suite is also the
    // proof that the two new rungs change nothing when they do not fire.
    boundary: null,
    escaped: false,
    stepLeftBoundary: null,
    stepRightBoundary: null,
    ...over,
  };
  // A collapsed caret IS its own focus, so unless a spec draws a range the
  // focus restates it.
  return {
    ...base,
    focus: over.focus ?? {
      offset: base.offset,
      atStart: base.atStart,
      atEnd: base.atEnd,
      onTopLine: base.onTopLine,
      onBottomLine: base.onBottomLine,
      x: base.caretX,
    },
  };
}

const NO_SHIFT = { shift: false };
const SHIFT = { shift: true };

// ---------------------------------------------------------------------------

describe("Enter", () => {
  test("shift+Enter passes through (soft newline)", () => {
    expect(resolveKeystroke("Enter", SHIFT, caret(), ctx("B"))).toEqual({
      type: "passthrough",
    });
  });

  test("split at the caret offset, asChild false by default", () => {
    expect(
      resolveKeystroke("Enter", NO_SHIFT, caret({ offset: 2 }), ctx("B")),
    ).toEqual({
      type: "split",
      position: 2,
      asChild: false,
      childType: undefined,
      siblingType: undefined,
      tailData: undefined,
    });
  });

  /** A selected range `[anchor, focus)` in a block of `length` characters. */
  function ranged(anchor: number, focus: number, length = 5): CaretContext {
    return caret({
      offset: anchor,
      collapsed: false,
      length,
      focus: {
        offset: focus,
        atStart: focus === 0,
        atEnd: focus === length,
        onTopLine: true,
        onBottomLine: true,
        x: 0,
      },
    });
  }

  test("Enter over a range splits where it starts and deletes up to its end", () => {
    expect(
      resolveKeystroke("Enter", NO_SHIFT, ranged(1, 3), ctx("B")),
    ).toMatchObject({ type: "split", position: 1, deleteTo: 3 });
  });

  test("…whichever way the range was drawn", () => {
    expect(
      resolveKeystroke("Enter", NO_SHIFT, ranged(3, 1), ctx("B")),
    ).toMatchObject({ type: "split", position: 1, deleteTo: 3 });
  });

  test("a range over the whole line is replaced, never the empty-Enter ladder", () => {
    // B is top-level and empty-Enter would convert it to the break-out type;
    // a selection is text being replaced, so the line splits instead.
    expect(
      resolveKeystroke(
        "Enter",
        NO_SHIFT,
        ranged(0, 5),
        ctx("B", { editPolicy: { breakOutOnEmptyEnter: "text" } }),
      ),
    ).toMatchObject({ type: "split", position: 0, deleteTo: 5 });
  });

  test("a range ending at the line's end nests under visible children, as Enter-at-end", () => {
    expect(
      resolveKeystroke("Enter", NO_SHIFT, ranged(2, 5), ctx("A")),
    ).toMatchObject({ type: "split", position: 2, deleteTo: 5, asChild: true });
    expect(
      resolveKeystroke("Enter", NO_SHIFT, ranged(2, 4), ctx("A")),
    ).toMatchObject({ type: "split", asChild: false });
  });

  test("a range from the line's start mints a head of the line's own type", () => {
    // As Enter at the start of a non-empty line: the new line is the part
    // BEFORE the caret, so it keeps the origin's type — no `splitInto` tail.
    expect(
      resolveKeystroke(
        "Enter",
        NO_SHIFT,
        ranged(0, 2),
        ctx("B", { editPolicy: { splitInto: "text" } }),
      ),
    ).toMatchObject({ type: "split", position: 0, siblingType: undefined });
  });

  test("Enter at start of a NON-EMPTY block still resolves to a plain position-0 split", () => {
    // Identity preservation (insert empty ABOVE, keep the origin) is decided
    // DOWNSTREAM in the reducer/executor from `position === 0 && afterRuns.length > 0`.
    // The resolver stays oblivious: A has text "hello", caret at the very start
    // (atStart, not atEnd) → an ordinary split at position 0, not asChild.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ offset: 0, atStart: true }),
      ctx("A"),
    );
    expect(intent).toEqual({
      type: "split",
      position: 0,
      asChild: false,
      childType: undefined,
      siblingType: undefined,
      tailData: undefined,
    });
  });

  test("asChild when splitting at the end of a block with expanded children", () => {
    // A is expanded with child A1; the live caret is at the block end.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ offset: 5, atEnd: true }),
      ctx("A"),
    );
    expect(intent).toEqual({
      type: "split",
      position: 5,
      asChild: true,
      childType: undefined,
      siblingType: undefined,
      tailData: undefined,
    });
  });

  test("not asChild when splitting mid-text even with children", () => {
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ offset: 2, atEnd: false }),
      ctx("A"),
    );
    expect(intent).toMatchObject({ type: "split", asChild: false });
  });

  test("asChild gates on the live caret edge, not the stale reducer text length", () => {
    // Regression: right after a markdown conversion the reducer node text lags the
    // live editor by one keystroke (node A still reads "hello", len 5), but the
    // live caret is genuinely at the end (atEnd) at a shorter offset. The nest must
    // fire off the live edge, not `offset === textLength`.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ offset: 2, atEnd: true }),
      ctx("A"),
    );
    expect(intent).toMatchObject({ type: "split", asChild: true });
  });

  test("explicit editPolicy.asChild is honored", () => {
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ offset: 0 }),
      ctx("B", {
        editPolicy: { asChild: true, childType: "to-do" },
      }),
    );
    expect(intent).toEqual({
      type: "split",
      position: 0,
      asChild: true,
      childType: "to-do",
      siblingType: undefined,
      tailData: undefined,
    });
  });

  test("splitInto: Enter at the END yields a sibling of that type", () => {
    // Gated on the live caret edge (caret.atEnd), not the reducer node length.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ atEnd: true }),
      ctx("B", {
        editPolicy: { splitInto: "text" },
      }),
    );
    expect(intent).toMatchObject({
      type: "split",
      asChild: false,
      siblingType: "text",
    });
  });

  test("splitInto: Enter MID-text also yields a sibling of that type", () => {
    // The tail of a heading is prose wherever the caret sat when it was made:
    // `splitInto` describes the tail, not the caret position that minted it.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ offset: 2, atEnd: false }),
      ctx("B", {
        editPolicy: { splitInto: "text" },
      }),
    );
    expect(intent).toMatchObject({
      type: "split",
      asChild: false,
      siblingType: "text",
    });
  });

  test("splitInto: Enter at the START keeps the type (the new row is the HEAD)", () => {
    // Position 0 with text after it inserts an EMPTY sibling above and leaves
    // the origin untouched — that row is the part before the caret, so it stays
    // a heading rather than becoming the paragraph the tail would be.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ offset: 0, atStart: true, atEnd: false }),
      ctx("B", {
        editPolicy: { splitInto: "text" },
      }),
    );
    expect(intent).toMatchObject({
      type: "split",
      position: 0,
      asChild: false,
      siblingType: undefined,
    });
  });

  test("splitInto: a nested tail (asChild) takes the split type too", () => {
    // A heading with visible children nests the split-off content as its first
    // child (Enter-at-end). That child is still the tail, so it is a paragraph —
    // an explicit `childType` (the toggle's) still wins.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ atEnd: true }),
      ctx("A", {
        editPolicy: { splitInto: "text" },
      }),
    );
    expect(intent).toMatchObject({
      type: "split",
      asChild: true,
      childType: "text",
      siblingType: undefined,
    });
  });

  test("empty block with breakOutOnEmptyEnter → convertTo (exits the list)", () => {
    // An empty bullet (type "bulleted-list") breaks out to "text" instead of
    // spawning another empty bullet.
    const nodes: BlockNode[] = [
      { ...mk("B", PAGE, rankB, { text: "" }), type: "bulleted-list" },
    ];
    // Empty == the live caret sits at both the start and the end of the block.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ atStart: true, atEnd: true }),
      {
        nodes,
        ...TYPE_FACTS,
        blockId: "B",
        editPolicy: { breakOutOnEmptyEnter: "text" },
      },
    );
    expect(intent).toEqual({ type: "convertTo", to: "text" });
  });

  test("non-empty block with breakOutOnEmptyEnter → split (no break-out)", () => {
    // A has text "hello" — Enter still splits despite the break-out policy.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ offset: 2 }),
      ctx("A", {
        editPolicy: { breakOutOnEmptyEnter: "text" },
      }),
    );
    expect(intent).toMatchObject({
      type: "split",
      position: 2,
      asChild: false,
    });
  });

  // Empty-Enter escape ladder: indentation first (outdent, keeping the type),
  // then the type (convertTo), then ordinary split — the OPPOSITE order to
  // Backspace's marker-first reset.
  test("empty-Enter: indented block with breakout policy → outdent (keep type)", () => {
    // An empty bullet indented under A escapes nesting outward before its type.
    const nodes: BlockNode[] = [
      mk("A", PAGE, rankA, { text: "hello", expanded: true }),
      { ...mk("A1", "A", rankChild, { text: "" }), type: "bulleted-list" },
      mk("B", PAGE, rankB),
    ];
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ atStart: true, atEnd: true }),
      {
        nodes,
        ...TYPE_FACTS,
        blockId: "A1",
        editPolicy: { breakOutOnEmptyEnter: "text" },
      },
    );
    expect(intent).toEqual({ type: "outdent" });
  });

  test("empty-Enter: indented block already the target type → still outdent", () => {
    // A1 (default tree) is indented and already "text"; empty-Enter still escapes
    // nesting first — outdent takes precedence over the (satisfied) type escape.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ atStart: true, atEnd: true }),
      ctx("A1", {
        editPolicy: { breakOutOnEmptyEnter: "text" },
      }),
    );
    expect(intent).toEqual({ type: "outdent" });
  });

  test("empty-Enter: top-level, already the target type → falls through to split", () => {
    // B is top-level and already "text"; no level left to escape → ordinary split.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ atStart: true, atEnd: true }),
      ctx("B", {
        editPolicy: { breakOutOnEmptyEnter: "text" },
      }),
    );
    expect(intent).toMatchObject({ type: "split", asChild: false });
  });

  test("empty-Enter: indented plain block WITHOUT breakout policy → split", () => {
    // No breakout policy → the empty-Enter ladder never engages; ordinary split.
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ atStart: true, atEnd: true }),
      ctx("A1"),
    );
    expect(intent).toMatchObject({ type: "split", asChild: false });
  });

  // dataOnSplit resolver: the tail's data transform is applied ONLY when the tail
  // block's type equals the origin's — a type-swapping split (siblingType /
  // differing childType) must not run the origin's transform on the other schema.
  test("tailData: applied on a same-type split (mid-text)", () => {
    const nodes: BlockNode[] = [
      {
        ...mk("B", PAGE, rankB, { text: "abc" }),
        type: "to-do",
        data: { text: "abc", checked: true },
      },
    ];
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ offset: 1, atEnd: false }),
      {
        nodes,
        ...TYPE_FACTS,
        blockId: "B",
        editPolicy: {
          dataOnSplit: (d) => ({ ...(d as object), checked: false }),
        },
      },
    );
    expect(intent).toMatchObject({
      type: "split",
      tailData: { text: "abc", checked: false },
    });
  });

  test("tailData: NOT applied when the end-split swaps sibling type", () => {
    const nodes: BlockNode[] = [
      {
        ...mk("B", PAGE, rankB, { text: "abc" }),
        type: "heading-1",
        data: { text: "abc" },
      },
    ];
    const intent = resolveKeystroke("Enter", NO_SHIFT, caret({ atEnd: true }), {
      nodes,
      ...TYPE_FACTS,
      blockId: "B",
      editPolicy: {
        splitInto: "text",
        dataOnSplit: (d) => ({ ...(d as object), swapped: true }),
      },
    });
    expect(intent).toMatchObject({
      type: "split",
      siblingType: "text",
      tailData: undefined,
    });
  });

  test("tailData: NOT applied when nesting as a child of a different type", () => {
    const nodes: BlockNode[] = [
      {
        ...mk("B", PAGE, rankB, { text: "abc" }),
        type: "toggle",
        data: { text: "abc" },
      },
    ];
    const intent = resolveKeystroke("Enter", NO_SHIFT, caret({ atEnd: true }), {
      nodes,
      ...TYPE_FACTS,
      blockId: "B",
      editPolicy: {
        asChild: true,
        childType: "text",
        dataOnSplit: (d) => ({ ...(d as object), swapped: true }),
      },
    });
    expect(intent).toMatchObject({
      type: "split",
      asChild: true,
      childType: "text",
      tailData: undefined,
    });
  });

  test("tailData: applied when nesting as a child WITHOUT an explicit childType", () => {
    // Tail type defaults to the origin type when childType is absent → applied.
    const nodes: BlockNode[] = [
      {
        ...mk("B", PAGE, rankB, { text: "abc" }),
        type: "to-do",
        data: { text: "abc", checked: true },
      },
    ];
    const intent = resolveKeystroke("Enter", NO_SHIFT, caret({ atEnd: true }), {
      nodes,
      ...TYPE_FACTS,
      blockId: "B",
      editPolicy: {
        asChild: true,
        dataOnSplit: (d) => ({ ...(d as object), checked: false }),
      },
    });
    expect(intent).toMatchObject({
      type: "split",
      asChild: true,
      tailData: { text: "abc", checked: false },
    });
  });
});

describe("Backspace", () => {
  test("not at start → passthrough (ordinary deletion)", () => {
    expect(
      resolveKeystroke(
        "Backspace",
        NO_SHIFT,
        caret({ atStart: false }),
        ctx("B"),
      ),
    ).toEqual({
      type: "passthrough",
    });
  });

  test("at start but a range is selected → passthrough", () => {
    expect(
      resolveKeystroke(
        "Backspace",
        NO_SHIFT,
        caret({ atStart: true, collapsed: false }),
        ctx("B"),
      ),
    ).toEqual({ type: "passthrough" });
  });

  test("at start, indented → outdent", () => {
    expect(
      resolveKeystroke(
        "Backspace",
        NO_SHIFT,
        caret({ atStart: true }),
        ctx("A1"),
      ),
    ).toEqual({ type: "outdent" });
  });

  test("at start, top-level with a previous sibling → merge", () => {
    expect(
      resolveKeystroke(
        "Backspace",
        NO_SHIFT,
        caret({ atStart: true }),
        ctx("B"),
      ),
    ).toEqual({ type: "merge" });
  });

  test("at start, formatted block (type !== reset target) → convertTo (reset before merge)", () => {
    // A bulleted item B (type "bulleted-list") at top level resets to "text"
    // first; a SECOND Backspace would then merge.
    const nodes: BlockNode[] = [
      mk("A", PAGE, rankA, { text: "hello" }),
      { ...mk("B", PAGE, rankB), type: "bulleted-list" },
    ];
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes,
        ...TYPE_FACTS,
        blockId: "B",
        editPolicy: { resetToOnBackspaceAtStart: "text" },
      }),
    ).toEqual({ type: "convertTo", to: "text" });
  });

  test("at start, already the reset target type → merge (no reset)", () => {
    // B is already "text"; the reset policy is a no-op, so Backspace merges.
    expect(
      resolveKeystroke(
        "Backspace",
        NO_SHIFT,
        caret({ atStart: true }),
        ctx("B", {
          editPolicy: { resetToOnBackspaceAtStart: "text" },
        }),
      ),
    ).toEqual({ type: "merge" });
  });

  test("at start, indented formatted block → convertTo (marker strips before indentation)", () => {
    // A1 is indented under A and formatted. The marker (bullet) is visually nearest
    // the caret, so it strips BEFORE the indentation — reset wins over outdent.
    const nodes: BlockNode[] = [
      mk("A", PAGE, rankA, { text: "hello", expanded: true }),
      { ...mk("A1", "A", rankChild), type: "bulleted-list" },
      mk("B", PAGE, rankB),
    ];
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes,
        ...TYPE_FACTS,
        blockId: "A1",
        editPolicy: { resetToOnBackspaceAtStart: "text" },
      }),
    ).toEqual({ type: "convertTo", to: "text" });
  });

  test("at start, indented + already the reset target type → outdent (no reset needed)", () => {
    // A1 (default tree) is indented and already "text": the reset policy is
    // satisfied (type === target), so the ladder falls to outdent.
    expect(
      resolveKeystroke(
        "Backspace",
        NO_SHIFT,
        caret({ atStart: true }),
        ctx("A1", {
          editPolicy: { resetToOnBackspaceAtStart: "text" },
        }),
      ),
    ).toEqual({ type: "outdent" });
  });

  test("at start, first top-level block → nav left (out to the preceding surface)", () => {
    expect(
      resolveKeystroke(
        "Backspace",
        NO_SHIFT,
        caret({ atStart: true }),
        ctx("A"),
      ),
    ).toEqual({ type: "nav", dir: "left" });
  });
});

describe("Delete", () => {
  test("not at end → passthrough (ordinary forward deletion)", () => {
    expect(
      resolveKeystroke("Delete", NO_SHIFT, caret({ atEnd: false }), ctx("A")),
    ).toEqual({
      type: "passthrough",
    });
  });

  test("at end but a range is selected → passthrough", () => {
    expect(
      resolveKeystroke(
        "Delete",
        NO_SHIFT,
        caret({ atEnd: true, collapsed: false }),
        ctx("A"),
      ),
    ).toEqual({ type: "passthrough" });
  });

  test("at end with a next visible line → mergeNext (pull the next line up)", () => {
    // A is expanded with child A1, so the visible line directly below A is A1.
    expect(
      resolveKeystroke("Delete", NO_SHIFT, caret({ atEnd: true }), ctx("A")),
    ).toEqual({ type: "mergeNext" });
  });

  test("at end of the LAST visible line → nav right (out to the following surface)", () => {
    // B is the last visible line; nothing follows it anywhere up the tree, so
    // Delete resolves to `nav right` — the exact mirror of Backspace's `nav left`.
    expect(
      resolveKeystroke("Delete", NO_SHIFT, caret({ atEnd: true }), ctx("B")),
    ).toEqual({ type: "nav", dir: "right" });
  });
});

describe("Tab", () => {
  test("with a previous sibling → indent", () => {
    expect(resolveKeystroke("Tab", NO_SHIFT, caret(), ctx("B"))).toEqual({
      type: "indent",
    });
  });

  test("first sibling (no prev) → noop (never insert a tab / move focus)", () => {
    expect(resolveKeystroke("Tab", NO_SHIFT, caret(), ctx("A"))).toEqual({
      type: "noop",
    });
  });

  test("shift+Tab when indented → outdent", () => {
    expect(resolveKeystroke("Tab", SHIFT, caret(), ctx("A1"))).toEqual({
      type: "outdent",
    });
  });

  test("shift+Tab at top level → noop", () => {
    expect(resolveKeystroke("Tab", SHIFT, caret(), ctx("B"))).toEqual({
      type: "noop",
    });
  });

  // A void block (bookmark, image, …) has no caret position, so its caret host
  // resolves Tab through `resolveTab` directly — it must agree with the text
  // ladder on every case above.
  test("resolveTab (caret-free) agrees with the keystroke ladder", () => {
    for (const id of ["A", "A1", "B"]) {
      for (const mods of [NO_SHIFT, SHIFT]) {
        expect(resolveKeystroke("Tab", mods, caret(), ctx(id))).toEqual(
          resolveTab(mods, ctx(id)),
        );
      }
    }
  });
});

describe("ArrowUp / ArrowDown", () => {
  test("Up on the top visual line → nav up", () => {
    expect(
      resolveKeystroke(
        "ArrowUp",
        NO_SHIFT,
        caret({ onTopLine: true }),
        ctx("B"),
      ),
    ).toEqual({
      type: "nav",
      dir: "up",
    });
  });

  test("Up not on the top visual line → passthrough (move within block)", () => {
    expect(
      resolveKeystroke(
        "ArrowUp",
        NO_SHIFT,
        caret({ onTopLine: false }),
        ctx("B"),
      ),
    ).toEqual({
      type: "passthrough",
    });
  });

  test("shift+Up on the top line → a text span into the line above", () => {
    expect(
      resolveKeystroke("ArrowUp", SHIFT, caret({ onTopLine: true }), ctx("B")),
    ).toEqual({ type: "extendSpan", dir: "up" });
  });

  test("shift+Up with no line above → the browser's (extends in-block)", () => {
    expect(
      resolveKeystroke("ArrowUp", SHIFT, caret({ onTopLine: true }), ctx("A")),
    ).toEqual({ type: "passthrough" });
  });

  test("shift+Up reads the selection's FOCUS, not its anchor", () => {
    // A range drawn down to the block's last line: its anchor is on the top
    // line, but extending upward moves the focus, which is not there.
    const ranged = caret({
      collapsed: false,
      onTopLine: true,
      focus: {
        offset: 5,
        atStart: false,
        atEnd: true,
        onTopLine: false,
        onBottomLine: true,
        x: 0,
      },
    });
    expect(resolveKeystroke("ArrowUp", SHIFT, ranged, ctx("B"))).toEqual({
      type: "passthrough",
    });
    expect(resolveKeystroke("ArrowDown", SHIFT, ranged, ctx("A"))).toEqual({
      type: "extendSpan",
      dir: "down",
    });
  });

  test("Down on the bottom visual line → nav down", () => {
    expect(
      resolveKeystroke(
        "ArrowDown",
        NO_SHIFT,
        caret({ onBottomLine: true }),
        ctx("A"),
      ),
    ).toEqual({ type: "nav", dir: "down" });
  });

  test("shift+Down on the bottom line → a text span into the line below", () => {
    expect(
      resolveKeystroke(
        "ArrowDown",
        SHIFT,
        caret({ onBottomLine: true }),
        ctx("A"),
      ),
    ).toEqual({ type: "extendSpan", dir: "down" });
  });

  test("shift+Down with no line below → the browser's", () => {
    expect(
      resolveKeystroke(
        "ArrowDown",
        SHIFT,
        caret({ onBottomLine: true }),
        ctx("B"),
      ),
    ).toEqual({ type: "passthrough" });
  });

  test("shift+Left / shift+Right at the block's edge → a text span", () => {
    expect(
      resolveKeystroke("ArrowLeft", SHIFT, caret({ atStart: true }), ctx("B")),
    ).toEqual({ type: "extendSpan", dir: "left" });
    expect(
      resolveKeystroke("ArrowRight", SHIFT, caret({ atEnd: true }), ctx("A")),
    ).toEqual({ type: "extendSpan", dir: "right" });
  });

  test("shift+Left / shift+Right inside the text → the browser's", () => {
    expect(
      resolveKeystroke("ArrowLeft", SHIFT, caret({ offset: 2 }), ctx("B")),
    ).toEqual({ type: "passthrough" });
    expect(
      resolveKeystroke("ArrowRight", SHIFT, caret({ offset: 2 }), ctx("A")),
    ).toEqual({ type: "passthrough" });
  });
});

describe("ArrowLeft / ArrowRight", () => {
  test("Left at the very start → nav left (to previous block end)", () => {
    expect(
      resolveKeystroke(
        "ArrowLeft",
        NO_SHIFT,
        caret({ atStart: true }),
        ctx("B"),
      ),
    ).toEqual({ type: "nav", dir: "left" });
  });

  test("Left not at start → passthrough", () => {
    expect(
      resolveKeystroke(
        "ArrowLeft",
        NO_SHIFT,
        caret({ atStart: false }),
        ctx("B"),
      ),
    ).toEqual({ type: "passthrough" });
  });

  test("shift+Left at the start of the FIRST line → passthrough (native)", () => {
    expect(
      resolveKeystroke("ArrowLeft", SHIFT, caret({ atStart: true }), ctx("A")),
    ).toEqual({ type: "passthrough" });
  });

  test("Right at the very end → nav right (to next block start)", () => {
    expect(
      resolveKeystroke(
        "ArrowRight",
        NO_SHIFT,
        caret({ atEnd: true }),
        ctx("A"),
      ),
    ).toEqual({ type: "nav", dir: "right" });
  });

  test("Right not at end → passthrough", () => {
    expect(
      resolveKeystroke(
        "ArrowRight",
        NO_SHIFT,
        caret({ atEnd: false }),
        ctx("A"),
      ),
    ).toEqual({ type: "passthrough" });
  });
});

// ---------------------------------------------------------------------------
// Trajectories: repeated presses of the SAME key, evolving the fixture between
// each press exactly as the executor would. Each ladder strips one structural
// level per press until it reaches a terminal intent (merge / split), so the
// SEQUENCE of intents is the observable contract, not any single decision.
// ---------------------------------------------------------------------------

/**
 * Drive one key repeatedly against `blockId`, applying the reducer effect of each
 * non-terminal intent (outdent via `applyBlockOp`; convertTo as a type swap) and
 * re-resolving, until a terminal intent (merge / split / nav / noop). Returns the
 * ordered list of intent types.
 */
function runTrajectory(
  initial: BlockNode[],
  blockId: string,
  key: KeystrokeKey,
  editPolicy: IntentContext["editPolicy"],
  caretOver: Partial<CaretContext>,
): string[] {
  let nodes = initial;
  const seq: string[] = [];
  for (let guard = 0; guard < 10; guard++) {
    const intent = resolveKeystroke(key, NO_SHIFT, caret(caretOver), {
      nodes,
      ...TYPE_FACTS,
      blockId,
      editPolicy,
    });
    seq.push(intent.type);
    if (intent.type === "outdent") {
      nodes = applyBlockOp(
        nodes,
        { kind: "outdent", blockIds: [blockId] },
        ANCHOR_CTX,
      );
    } else if (intent.type === "unwrap") {
      // The container dissolves and its children are promoted into its slot —
      // the caret's block keeps its id, so the next press re-resolves against it.
      nodes = applyBlockOp(
        nodes,
        { kind: "unwrap", blockId: intent.blockId },
        ANCHOR_CTX,
      );
    } else if (intent.type === "convertTo") {
      nodes = nodes.map((n) =>
        n.id === blockId ? { ...n, type: intent.to } : n,
      );
    } else if (intent.type === "mergeNext") {
      // Delete pulls the NEXT visible line up: the executor merges that line into
      // `blockId`, so mirror it here by merging `nextVisibleLine(blockId)` away.
      const node = nodes.find((n) => n.id === blockId)!;
      const next = nextVisibleLine(nodes, node);
      if (!next) break; // unreachable: mergeNext implies a next line exists
      nodes = applyBlockOp(
        nodes,
        { kind: "merge", blockId: next.id },
        ANCHOR_CTX,
      );
    } else {
      break; // merge / split / nav / noop — a trajectory ends here
    }
  }
  return seq;
}

describe("trajectories", () => {
  test("Backspace: formatted nested block → [convertTo, outdent, merge]", () => {
    // page ▸ A ▸ X(bulleted-list, indented). Marker strips, then indentation,
    // then the line break above (X lands after A, so merge has a prev sibling).
    const nodes: BlockNode[] = [
      mk("A", PAGE, rankA, { text: "hello", expanded: true }),
      { ...mk("X", "A", rankChild, { text: "item" }), type: "bulleted-list" },
    ];
    expect(
      runTrajectory(
        nodes,
        "X",
        "Backspace",
        { resetToOnBackspaceAtStart: "text" },
        { atStart: true },
      ),
    ).toEqual(["convertTo", "outdent", "merge"]);
  });

  test("Backspace: plain block nested two deep → [outdent, outdent, merge]", () => {
    // page ▸ A ▸ B ▸ X(text). No marker to strip; two levels of indentation peel
    // off, then merge into the previous visible line.
    const rankB2 = Rank.between(null, null).toJSON();
    const nodes: BlockNode[] = [
      mk("A", PAGE, rankA, { text: "a", expanded: true }),
      mk("B", "A", rankB2, { text: "b", expanded: true }),
      mk("X", "B", rankChild, { text: "x" }),
    ];
    expect(
      runTrajectory(nodes, "X", "Backspace", undefined, { atStart: true }),
    ).toEqual(["outdent", "outdent", "merge"]);
  });

  test("Backspace: nested block peels only its EXCESS indentation → [outdent, merge]", () => {
    // page ▸ A ▸ [B ▸ X, C]. X sits one level deeper than the line below it (C),
    // so the first press strips that one excess level — landing X between B and C,
    // level with C — and the second, with no excess left, deletes the line break
    // above (merging into B). Two presses, not three: the level X SHARES with C
    // never comes off.
    const rankB2 = Rank.between(null, null).toJSON();
    const rankC2 = Rank.between(Rank.from(rankB2), null).toJSON();
    const nodes: BlockNode[] = [
      mk("A", PAGE, rankA, { text: "aaa", expanded: true }),
      mk("B", "A", rankB2, { text: "aaa", expanded: true }),
      mk("X", "B", rankChild, { text: "bbb" }),
      mk("C", "A", rankC2, { text: "ccc" }),
    ];
    expect(
      runTrajectory(nodes, "X", "Backspace", undefined, { atStart: true }),
    ).toEqual(["outdent", "merge"]);
    // And the outdent lands X where the caret expects it: level with C, ABOVE it.
    const after = applyBlockOp(
      nodes,
      { kind: "outdent", blockIds: ["X"] },
      ANCHOR_CTX,
    );
    expect(after.find((n) => n.id === "X")!.parentId).toBe("A");
    expect(
      nextVisibleLine(
        after,
        after.find((n) => n.id === "X")!,
      )?.id,
    ).toBe("C");
    // C is untouched — the outdent adopted nothing (excess implies no follower).
    expect(after.find((n) => n.id === "C")!.parentId).toBe("A");
  });

  test("empty-Enter: empty bullet nested two deep → [outdent, outdent, convertTo, split]", () => {
    // page ▸ A ▸ B ▸ X(empty bulleted-list, breakout policy). Nesting escapes
    // outward twice, THEN the type escapes (convertTo), THEN ordinary split.
    const rankB2 = Rank.between(null, null).toJSON();
    const nodes: BlockNode[] = [
      mk("A", PAGE, rankA, { text: "a", expanded: true }),
      mk("B", "A", rankB2, { text: "b", expanded: true }),
      { ...mk("X", "B", rankChild, { text: "" }), type: "bulleted-list" },
    ];
    expect(
      runTrajectory(
        nodes,
        "X",
        "Enter",
        { breakOutOnEmptyEnter: "text" },
        { atStart: true, atEnd: true },
      ),
    ).toEqual(["outdent", "outdent", "convertTo", "split"]);
  });

  test("empty-Enter: empty indented plain block without policy → [split]", () => {
    // No breakout policy → the ladder never engages; the first press already splits.
    const nodes: BlockNode[] = [
      mk("A", PAGE, rankA, { text: "a", expanded: true }),
      mk("X", "A", rankChild, { text: "" }),
    ];
    expect(
      runTrajectory(nodes, "X", "Enter", undefined, {
        atStart: true,
        atEnd: true,
      }),
    ).toEqual(["split"]);
  });

  // Empty-Enter inside a CONTAINER steps out of the box only on its last line;
  // anywhere else it stays in the box. The regression: an empty bullet in the
  // MIDDLE of a callout took the outdent rung, and `outdentOne` carried the lines
  // below it out of the box — the callout cut in two around the caret.
  function boxed(kids: { id: string; text: string; type?: string }[]) {
    const ranks = Rank.nBetween(null, null, kids.length);
    return [
      { ...mk("CA", PAGE, rankA), type: "callout", expanded: true },
      ...kids.map((k, i) => ({
        ...mk(k.id, "CA", ranks[i]!.toJSON(), { text: k.text }),
        type: k.type ?? "text",
      })),
      mk("B", PAGE, rankB, { text: "after" }),
    ];
  }
  const EMPTY = { atStart: true, atEnd: true };

  test("empty-Enter: empty plain line in the MIDDLE of a callout → [split]", () => {
    const nodes = boxed([
      { id: "X1", text: "aaa" },
      { id: "X", text: "" },
      { id: "X3", text: "bbb" },
    ]);
    expect(runTrajectory(nodes, "X", "Enter", undefined, EMPTY)).toEqual([
      "split",
    ]);
  });

  test("empty-Enter: empty bullet in the MIDDLE of a callout → [convertTo, split], never outdent", () => {
    const nodes = boxed([
      { id: "X1", text: "aaa", type: "bulleted-list" },
      { id: "X", text: "", type: "bulleted-list" },
      { id: "X3", text: "bbb", type: "bulleted-list" },
    ]);
    expect(
      runTrajectory(
        nodes,
        "X",
        "Enter",
        { breakOutOnEmptyEnter: "text" },
        EMPTY,
      ),
    ).toEqual(["convertTo", "split"]);
  });

  test("empty-Enter: empty LAST line of a callout → [outdent] lands it right after the box", () => {
    const nodes = boxed([
      { id: "X1", text: "aaa" },
      { id: "X", text: "" },
    ]);
    expect(runTrajectory(nodes, "X", "Enter", undefined, EMPTY)).toEqual([
      "outdent",
      "split",
    ]);
    const after = applyBlockOp(
      nodes,
      { kind: "outdent", blockIds: ["X"] },
      ANCHOR_CTX,
    );
    expect(after.find((n) => n.id === "X")!.parentId).toBe(PAGE);
    expect(after.find((n) => n.id === "X1")!.parentId).toBe("CA");
    expect(
      nextVisibleLine(
        after,
        after.find((n) => n.id === "X1")!,
      )?.id,
    ).toBe("X");
  });

  test("empty-Enter: a callout's ONLY line stays in the box → [split]", () => {
    // `/callout` on an empty line, then Enter: the box must not dissolve.
    const nodes = boxed([{ id: "X", text: "" }]);
    expect(runTrajectory(nodes, "X", "Enter", undefined, EMPTY)).toEqual([
      "split",
    ]);
  });

  test("Shift+Tab in the MIDDLE of a callout leaves the box whole", () => {
    // The generic half of the bug: every outdent goes through `outdentOne`,
    // which must not adopt a container's remaining lines.
    const nodes = boxed([
      { id: "X1", text: "aaa" },
      { id: "X", text: "mid" },
      { id: "X3", text: "bbb" },
    ]);
    const after = applyBlockOp(
      nodes,
      { kind: "outdent", blockIds: ["X"] },
      ANCHOR_CTX,
    );
    expect(after.find((n) => n.id === "X")!.parentId).toBe(PAGE);
    expect(after.find((n) => n.id === "X1")!.parentId).toBe("CA");
    expect(after.find((n) => n.id === "X3")!.parentId).toBe("CA");
  });

  test("Backspace: first line of a callout below a text block → [unwrap, merge]", () => {
    // page ▸ A ("a"), CA(anchor) ▸ [X, Y]. The first press dissolves the box —
    // X and Y become plain siblings after A, NOT X adopting Y — so the second
    // press is the ordinary merge into the line above.
    const rankCA = Rank.between(Rank.from(rankA), null).toJSON();
    const kid1 = Rank.between(null, null).toJSON();
    const kid2 = Rank.between(Rank.from(kid1), null).toJSON();
    const nodes: BlockNode[] = [
      mk("A", PAGE, rankA, { text: "a" }),
      { ...mk("CA", PAGE, rankCA), type: "callout", expanded: true },
      mk("X", "CA", kid1, { text: "x" }),
      mk("Y", "CA", kid2, { text: "y" }),
    ];
    expect(
      runTrajectory(nodes, "X", "Backspace", undefined, { atStart: true }),
    ).toEqual(["unwrap", "merge"]);
  });

  test("Backspace: formatted first line of a LEADING callout → [convertTo, unwrap, nav]", () => {
    // page ▸ CA(anchor) ▸ X(bulleted-list). Marker strips, the box dissolves,
    // and X — now the first top-level line — has nothing above it to merge into.
    const nodes: BlockNode[] = [
      { ...mk("CA", PAGE, rankA), type: "callout", expanded: true },
      { ...mk("X", "CA", rankChild, { text: "item" }), type: "bulleted-list" },
    ];
    expect(
      runTrajectory(
        nodes,
        "X",
        "Backspace",
        { resetToOnBackspaceAtStart: "text" },
        { atStart: true },
      ),
    ).toEqual(["convertTo", "unwrap", "nav"]);
  });

  test("Delete: repeated at the end of a block with a subtree flattens it one line per press → [mergeNext, mergeNext, nav]", () => {
    // page ▸ P (expanded, ├ C1 └ C2). Delete at the end of P pulls each next
    // visible line up in turn; once P is the only line left it steps out (nav).
    const c1 = Rank.between(null, null).toJSON();
    const c2 = Rank.between(Rank.from(c1), null).toJSON();
    const nodes: BlockNode[] = [
      mk("P", PAGE, rankA, { text: "p", expanded: true }),
      mk("C1", "P", c1, { text: "c1" }),
      mk("C2", "P", c2, { text: "c2" }),
    ];
    expect(
      runTrajectory(nodes, "P", "Delete", undefined, { atEnd: true }),
    ).toEqual(["mergeNext", "mergeNext", "nav"]);
  });
});

// ---------------------------------------------------------------------------
// Multi-page union boundaries: the composite store splices several pages'
// blocks into ONE flat array, each row carrying its own `pageId` (nearest page
// ancestor). Structural intents must never span two pages — the resolver gates
// merge/mergeNext/outdent on the ROW's page, never a context scalar.
//
// The page SHELL row is refused by the second gate, `acceptsText`, which is a
// property of its (text-less) schema — not by a `type === "page"` comparison,
// which the resolver no longer makes. Every outcome below is unchanged from when
// it was one; that is exactly what makes this describe the regression test for
// the generalization. `void lines` below covers the types the old comparison
// silently let through.
// ---------------------------------------------------------------------------

describe("multi-page union boundaries", () => {
  const rankS = Rank.between(Rank.from(rankA), null).toJSON();
  const rankD = Rank.between(Rank.from(rankS), null).toJSON();
  const rankInB = Rank.between(null, null).toJSON();
  const rankInC = Rank.between(Rank.from(rankInB), null).toJSON();

  /**
   * Spliced union of the outer page and sub-page S:
   *   page (outer, not a row)
   *   ├─ A
   *   ├─ S (type "page" shell row — pageId = outer page)
   *   │  ├─ B (pageId = S)
   *   │  └─ C (pageId = S)
   *   └─ D
   * Collapsed variant drops the inner rows (their feed never mounts).
   */
  function union({
    expanded = true,
  }: { expanded?: boolean } = {}): BlockNode[] {
    const rows: BlockNode[] = [
      mk("A", PAGE, rankA, { text: "aa" }),
      { ...mk("S", PAGE, rankS), type: "page", expanded },
      { ...mk("B", "S", rankInB, { text: "bb" }), pageId: "S" },
      { ...mk("C", "S", rankInC, { text: "cc" }), pageId: "S" },
      mk("D", PAGE, rankD, { text: "dd" }),
    ];
    return expanded ? rows : rows.filter((n) => n.pageId !== "S");
  }

  test("shift+Tab on an inner page's top-level block → noop (not indented, no cross-page outdent)", () => {
    expect(
      resolveKeystroke("Tab", SHIFT, caret(), {
        nodes: union(),
        ...TYPE_FACTS,
        blockId: "B",
      }),
    ).toEqual({
      type: "noop",
    });
  });

  test("shift+Tab on a genuinely nested inner block → outdent (within its own page)", () => {
    const nodes = union().map((n) =>
      n.id === "B" ? { ...n, expanded: true } : n,
    );
    nodes.push({ ...mk("E", "B", rankChild, { text: "ee" }), pageId: "S" });
    expect(
      resolveKeystroke("Tab", SHIFT, caret(), {
        nodes,
        ...TYPE_FACTS,
        blockId: "E",
      }),
    ).toEqual({
      type: "outdent",
    });
  });

  test("empty-Enter on an inner page's top-level block → split, not a cross-page outdent", () => {
    const intent = resolveKeystroke(
      "Enter",
      NO_SHIFT,
      caret({ atStart: true, atEnd: true }),
      {
        nodes: union(),
        ...TYPE_FACTS,
        blockId: "B",
        editPolicy: { breakOutOnEmptyEnter: "text" },
      },
    );
    expect(intent).toMatchObject({ type: "split" });
  });

  test("Backspace at D below an EXPANDED sub-page → nav left (prev visible line C is cross-page)", () => {
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: union(),
        ...TYPE_FACTS,
        blockId: "D",
      }),
    ).toEqual({ type: "nav", dir: "left" });
  });

  test("Backspace at D below a COLLAPSED sub-page → nav left (a page shell row carries no text)", () => {
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: union({ expanded: false }),
        ...TYPE_FACTS,
        blockId: "D",
      }),
    ).toEqual({ type: "nav", dir: "left" });
  });

  test("Backspace at the FIRST child of an expanded sub-page → nav left (its prev visible line is the shell)", () => {
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: union(),
        ...TYPE_FACTS,
        blockId: "B",
      }),
    ).toEqual({ type: "nav", dir: "left" });
  });

  test("Backspace at an inner block whose prev visible line is same-page → merge (regression)", () => {
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: union(),
        ...TYPE_FACTS,
        blockId: "C",
      }),
    ).toEqual({ type: "merge" });
  });

  test("Delete at end of A (next visible line is the page shell row) → nav right", () => {
    expect(
      resolveKeystroke("Delete", NO_SHIFT, caret({ atEnd: true }), {
        nodes: union(),
        ...TYPE_FACTS,
        blockId: "A",
      }),
    ).toEqual({ type: "nav", dir: "right" });
  });

  test("Delete at end of the LAST inner block (next visible line D is cross-page) → nav right", () => {
    expect(
      resolveKeystroke("Delete", NO_SHIFT, caret({ atEnd: true }), {
        nodes: union(),
        ...TYPE_FACTS,
        blockId: "C",
      }),
    ).toEqual({ type: "nav", dir: "right" });
  });

  test("Delete at end of an inner block whose next visible line is same-page → mergeNext (regression)", () => {
    expect(
      resolveKeystroke("Delete", NO_SHIFT, caret({ atEnd: true }), {
        nodes: union(),
        ...TYPE_FACTS,
        blockId: "B",
      }),
    ).toEqual({ type: "mergeNext" });
  });
});

// ---------------------------------------------------------------------------
// Void lines: the types the OLD `type === PAGE_BLOCK_TYPE` gate silently let
// through. `nextVisibleLine` happily returns a container anchor or a divider, so
// Delete at the end of the line directly above one used to resolve to
// `mergeNext` — which writes `data.text` onto a schema that has none (a 400 at
// the write boundary) and, for an anchor, deletes the container out from under
// its children, dissolving the box on ONE keypress. `acceptsText` demotes both
// to a plain caret move.
// ---------------------------------------------------------------------------

describe("void lines (acceptsText)", () => {
  const rankVoid = Rank.between(Rank.from(rankA), null).toJSON();

  /** page ▸ A ("hello"), V (a void row of `type`), B. */
  function withVoid(
    type: string,
    opts: { expanded?: boolean } = {},
  ): BlockNode[] {
    return [
      mk("A", PAGE, rankA, { text: "hello" }),
      { ...mk("V", PAGE, rankVoid), type, expanded: opts.expanded ?? false },
      mk("B", PAGE, rankB),
    ];
  }

  test("Delete at the end of the line above a container ANCHOR → nav right", () => {
    expect(
      resolveKeystroke("Delete", NO_SHIFT, caret({ atEnd: true }), {
        nodes: withVoid("callout"),
        ...TYPE_FACTS,
        blockId: "A",
      }),
    ).toEqual({ type: "nav", dir: "right" });
  });

  test("Delete at the end of the line above a DIVIDER → nav right", () => {
    expect(
      resolveKeystroke("Delete", NO_SHIFT, caret({ atEnd: true }), {
        nodes: withVoid("divider"),
        ...TYPE_FACTS,
        blockId: "A",
      }),
    ).toEqual({ type: "nav", dir: "right" });
  });

  test("Delete above an EXPANDED anchor still resolves on its first CHILD, which is text → mergeNext", () => {
    // The anchor renders no line, but `nextVisibleLine` does not skip it — see
    // the design doc's deliberate non-goal. With children it returns the anchor
    // itself (the first visible child comes after), so this is still `nav right`;
    // once the caret is INSIDE the box the ordinary ladder applies.
    const nodes = [
      ...withVoid("callout", { expanded: true }),
      mk("V1", "V", rankChild, { text: "inside" }),
    ];
    expect(
      resolveKeystroke("Delete", NO_SHIFT, caret({ atEnd: true }), {
        nodes,
        ...TYPE_FACTS,
        blockId: "A",
      }),
    ).toEqual({ type: "nav", dir: "right" });
    // From the anchor's own child, the next visible line is the text block B.
    expect(
      resolveKeystroke("Delete", NO_SHIFT, caret({ atEnd: true }), {
        nodes,
        ...TYPE_FACTS,
        blockId: "V1",
      }),
    ).toEqual({ type: "mergeNext" });
  });

  test("Backspace at the start of the line BELOW a divider → nav left (nothing to merge into)", () => {
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: withVoid("divider"),
        ...TYPE_FACTS,
        blockId: "B",
      }),
    ).toEqual({ type: "nav", dir: "left" });
  });
});

// ---------------------------------------------------------------------------
// Container anchors: escaping the box. The generic ladder would resolve "start
// of the first child" to the `isIndented` → outdent rung, and `outdentOne`
// adopts the followers — so the first line would pop out of the box AND take
// the rest of the container's content with it as its own children. `unwrap`
// dissolves only the container.
// ---------------------------------------------------------------------------

describe("container anchors", () => {
  const rankCA = Rank.between(Rank.from(rankA), null).toJSON();
  const kid1 = Rank.between(null, null).toJSON();
  const kid2 = Rank.between(Rank.from(kid1), null).toJSON();

  /** page ▸ A ("hello"), CA(callout anchor) ▸ [X, Y]. */
  function boxed(childType = "text"): BlockNode[] {
    return [
      mk("A", PAGE, rankA, { text: "hello" }),
      { ...mk("CA", PAGE, rankCA), type: "callout", expanded: true },
      { ...mk("X", "CA", kid1, { text: "first" }), type: childType },
      mk("Y", "CA", kid2, { text: "second" }),
    ];
  }

  test("Backspace at the start of an anchor's FIRST child → unwrap the anchor", () => {
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: boxed(),
        ...TYPE_FACTS,
        blockId: "X",
      }),
    ).toEqual({ type: "unwrap", blockId: "CA" });
  });

  test("the unwrap rung beats outdent, which would move the first line below the box", () => {
    // Sanity-check the alternative the rung exists to avoid. Out of a container
    // `outdentOne` adopts nothing (it would carry the box's other lines out under
    // X), so X lands AFTER the box — below Y, the line it used to precede.
    const outdented = applyBlockOp(
      boxed(),
      { kind: "outdent", blockIds: ["X"] },
      ANCHOR_CTX,
    );
    expect(outdented.find((n) => n.id === "Y")!.parentId).toBe("CA");
    expect(outdented.find((n) => n.id === "X")!.parentId).toBe(PAGE);
    // Unwrapping instead leaves both lines as plain siblings at CA's level.
    const unwrapped = applyBlockOp(
      boxed(),
      { kind: "unwrap", blockId: "CA" },
      ANCHOR_CTX,
    );
    expect(unwrapped.find((n) => n.id === "X")!.parentId).toBe(PAGE);
    expect(unwrapped.find((n) => n.id === "Y")!.parentId).toBe(PAGE);
    expect(unwrapped.some((n) => n.id === "CA")).toBe(false);
  });

  test("a LATER child is NOT the unwrap rung — it takes the generic indentation rung", () => {
    // Only the FIRST child dissolves the box. A later line inside it is an
    // ordinary indented block taking the generic ladder — and Y is the LAST
    // visible line in the box, so its indentation is excess: it outdents (which,
    // for a line inside a container, means leaving the box).
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: boxed(),
        ...TYPE_FACTS,
        blockId: "Y",
      }),
    ).toEqual({ type: "outdent" });
    // Give Y a follower inside the box and it shares its indentation with it, so
    // the same line merges into X instead of being ejected from the container.
    const kid3 = Rank.between(Rank.from(kid2), null).toJSON();
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: [...boxed(), mk("Z", "CA", kid3, { text: "third" })],
        ...TYPE_FACTS,
        blockId: "Y",
      }),
    ).toEqual({ type: "merge" });
  });

  test("the marker still strips first: a formatted first child resets its type before unwrapping", () => {
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: boxed("bulleted-list"),
        ...TYPE_FACTS,
        blockId: "X",
        editPolicy: { resetToOnBackspaceAtStart: "text" },
      }),
    ).toEqual({ type: "convertTo", to: "text" });
  });

  test("a first child of an ORDINARY block is NOT unwrapped — it takes the generic ladder", () => {
    // The rung is anchor-only: an ordinary parent renders a line of its own, so
    // there is nothing to dissolve. X shares its indentation with its follower Y,
    // so the generic ladder merges it into that line rather than outdenting —
    // which is also what keeps `outdentOne` from adopting Y as X's child.
    const nodes = boxed().map((n) =>
      n.id === "CA" ? { ...n, type: "toggle" } : n,
    );
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes,
        ...TYPE_FACTS,
        blockId: "X",
      }),
    ).toEqual({ type: "merge" });
    // With no follower to share the indentation with, the same first child is
    // excess-indented and outdents — still never `unwrap`.
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: nodes.filter((n) => n.id !== "Y"),
        ...TYPE_FACTS,
        blockId: "X",
      }),
    ).toEqual({ type: "outdent" });
  });

  // -------------------------------------------------------------------------
  // ...and the same box, CLOSED. You cannot restructure what you cannot see: the
  // borrowed line is the only line a collapsed container shows, so every
  // structural keystroke on it would otherwise act on lines the user has no way
  // of knowing are there.
  // -------------------------------------------------------------------------

  /** The same fixture with the box folded: only X's line renders. */
  function closed(childType = "text"): BlockNode[] {
    return boxed(childType).map((n) =>
      n.id === "CA" ? { ...n, expanded: false } : n,
    );
  }

  test("Backspace on a COLLAPSED container's borrowed line opens it instead of unwrapping", () => {
    // `unwrap` here would dissolve the box and spill Y — a line the user cannot
    // see — into the document from one keypress.
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: closed(),
        ...TYPE_FACTS,
        blockId: "X",
      }),
    ).toEqual({ type: "expand", blockId: "CA" });
  });

  test("Shift+Tab on that line opens it too — outdent would ADOPT the hidden lines", () => {
    // `outdentOne` takes the followers, so outdenting X out of a closed box would
    // re-nest Y under X: invisible content, silently restructured.
    expect(
      resolveKeystroke("Tab", { shift: true }, caret({ atStart: true }), {
        nodes: closed(),
        ...TYPE_FACTS,
        blockId: "X",
      }),
    ).toEqual({ type: "expand", blockId: "CA" });
  });

  test("opening is ONE level per press — the next Backspace then unwraps as usual", () => {
    // The same bargain empty-Enter's ladder already makes. After the expand the
    // forest is the ordinary open box, so the ordinary rung applies.
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: boxed(),
        ...TYPE_FACTS,
        blockId: "X",
      }),
    ).toEqual({ type: "unwrap", blockId: "CA" });
  });

  test("the marker STILL strips first — the expand rung sits below convertTo", () => {
    // Stripping a bullet is a visible, local edit that neither reveals nor
    // restructures anything hidden, so it keeps its place at the top.
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes: closed("bulleted-list"),
        ...TYPE_FACTS,
        blockId: "X",
        editPolicy: { resetToOnBackspaceAtStart: "text" },
      }),
    ).toEqual({ type: "convertTo", to: "text" });
  });

  test("Delete at the end of a collapsed box's line skips the folded lines entirely", () => {
    // `nextVisibleLine` resumes ABOVE the outermost collapsed container, so the
    // line pulled up is the one after the whole box — never the hidden Y.
    const nodes = [...closed(), mk("B", PAGE, rankB, { text: "after" })];
    expect(
      resolveKeystroke("Delete", NO_SHIFT, caret({ atEnd: true }), {
        nodes,
        ...TYPE_FACTS,
        blockId: "X",
      }),
    ).toEqual({ type: "mergeNext" });
    expect(
      nextVisibleLine(
        nodes,
        nodes.find((n) => n.id === "X")!,
        TYPE_FACTS.isAnchor,
      )?.id,
    ).toBe("B");
  });

  test("Backspace on the line AFTER a collapsed box merges into its BORROWED line", () => {
    // The box is not empty space above: it paints X's line, so that is the
    // previous visible line and the one the text joins.
    const nodes = [...closed(), mk("B", PAGE, rankB, { text: "after" })];
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes,
        ...TYPE_FACTS,
        blockId: "B",
      }),
    ).toEqual({ type: "merge" });
  });

  test("Enter at the end of a collapsed box's line does NOT nest into hidden children", () => {
    // `asChild` reads VISIBLE children: X's own child is sealed away by the box,
    // so Enter is a plain sibling split (which `applySplit` then makes visible by
    // opening the container).
    const grandkid = Rank.between(null, null).toJSON();
    const nodes = [...closed(), mk("X1", "X", grandkid, { text: "nested" })];
    expect(
      resolveKeystroke("Enter", NO_SHIFT, caret({ atEnd: true, offset: 5 }), {
        nodes,
        ...TYPE_FACTS,
        blockId: "X",
      }),
    ).toMatchObject({ type: "split", asChild: false });
  });
});

// ---------------------------------------------------------------------------
// Excess indentation: WHICH of Backspace's two middle rungs goes first.
//
// Indentation is only nearer to the caret than the line break above while it is
// the block's OWN excess — while the block sits DEEPER than the visible line
// below it. Indentation shared with the content that follows is not something
// standing between the caret and that line break, so the ladder merges instead
// and the outdent rung becomes the fallback for when nothing above is mergeable.
// ---------------------------------------------------------------------------

describe("excess indentation (outdent vs merge order)", () => {
  const kid1 = Rank.between(null, null).toJSON();
  const kid2 = Rank.between(Rank.from(kid1), null).toJSON();

  function backspaceAt(nodes: BlockNode[], blockId: string) {
    return resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
      nodes,
      ...TYPE_FACTS,
      blockId,
    });
  }

  test("a following SIBLING shares the indentation → merge, not outdent", () => {
    // page ▸ A ▸ [X, Y]. X and Y are equally indented, so X has no excess.
    const nodes = [
      mk("A", PAGE, rankA, { text: "aaa", expanded: true }),
      mk("X", "A", kid1, { text: "bbb" }),
      mk("Y", "A", kid2, { text: "ccc" }),
    ];
    expect(backspaceAt(nodes, "X")).toEqual({ type: "merge" });
    // Y, the last visible line of A's subtree, has nothing below it at all — so
    // its indentation IS excess and it still peels off one level per press.
    expect(backspaceAt(nodes, "Y")).toEqual({ type: "outdent" });
  });

  test("a visible CHILD is deeper still → merge (its own subtree is what follows)", () => {
    // page ▸ A ▸ X ▸ C. Nothing about X's indentation is excess relative to C.
    const nodes = [
      mk("A", PAGE, rankA, { text: "aaa", expanded: true }),
      mk("X", "A", kid1, { text: "bbb", expanded: true }),
      mk("C", "X", kid1, { text: "ccc" }),
    ];
    expect(backspaceAt(nodes, "X")).toEqual({ type: "merge" });
    // COLLAPSED, those children are not visible lines, so X is the last visible
    // line of A's subtree again and the excess rung returns.
    const collapsed = nodes.map((n) =>
      n.id === "X" ? { ...n, expanded: false } : n,
    );
    expect(backspaceAt(collapsed, "X")).toEqual({ type: "outdent" });
  });

  test("the fallback: non-excess indentation still outdents when nothing above is mergeable", () => {
    // page ▸ A ▸ [D(divider), X, Y]. X shares its indentation with Y, but its
    // previous visible line is text-less — there is no line break to delete — so
    // the deferred outdent rung is what keeps X able to escape the nesting.
    const kid3 = Rank.between(Rank.from(kid2), null).toJSON();
    const nodes = [
      mk("A", PAGE, rankA, { text: "aaa", expanded: true }),
      { ...mk("D", "A", kid1), type: "divider" },
      mk("X", "A", kid2, { text: "bbb" }),
      mk("Y", "A", kid3, { text: "ccc" }),
    ];
    expect(backspaceAt(nodes, "X")).toEqual({ type: "outdent" });
  });

  test("the marker still strips before either rung", () => {
    const nodes = [
      mk("A", PAGE, rankA, { text: "aaa", expanded: true }),
      { ...mk("X", "A", kid1, { text: "bbb" }), type: "bulleted-list" },
      mk("Y", "A", kid2, { text: "ccc" }),
    ];
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, caret({ atStart: true }), {
        nodes,
        ...TYPE_FACTS,
        blockId: "X",
        editPolicy: { resetToOnBackspaceAtStart: "text" },
      }),
    ).toEqual({ type: "convertTo", to: "text" });
  });
});

// ---------------------------------------------------------------------------
// The virtual mark delimiter. Two rungs sit above the ladders: the arrow step
// across a boundary's invisible delimiter, and its deletion.
//
// The deletion rung's gate is `caret.escaped` — depth set by our OWN step and
// nothing else. Three shipped mechanisms leave a caret whose `selection.format`
// diverges from its node's bits without being a step (Cmd+E on a collapsed
// caret, `applyInlineFormat`'s `preFormat` restore, a merge landing), so a gate
// that read the format instead would turn each of them into a silent strip of a
// whole span. The `escaped: false` cases below are that regression.
// ---------------------------------------------------------------------------

describe("mark boundary", () => {
  /** `` `zz`| `` — a code run at the END of the block, caret inside its far edge. */
  const atBlockEnd: MarkBoundary = {
    left: ["code"],
    right: [],
    natural: ["code"],
  };
  /** `` |`zz` `` — a code run at the START of the block. */
  const atBlockStart: MarkBoundary = {
    left: [],
    right: ["code"],
    natural: ["code"],
  };
  /**
   * `` a|`zz` `` — a marked run on the RIGHT of a seam, the browser anchored on
   * the plain run's end. The stop is the state INSIDE the code run at its start,
   * which is what makes prepending into a code span possible; the retired
   * `left ∩ right` rule computed `{}` here, saw that `natural` already carried
   * it, and synthesized no stop at all.
   */
  const markedRight: MarkBoundary = { left: [], right: ["code"], natural: [] };

  describe("stepping across it", () => {
    test("ArrowRight at the end of a trailing marked run steps OUT", () => {
      expect(
        resolveKeystroke(
          "ArrowRight",
          NO_SHIFT,
          caret({ atEnd: true, boundary: atBlockEnd }),
          ctx("A"),
        ),
      ).toEqual({ type: "markStep", marks: [], escaped: true });
    });

    test("...and ArrowLeft from there steps back INSIDE, restoring the run's marks", () => {
      expect(
        resolveKeystroke(
          "ArrowLeft",
          NO_SHIFT,
          caret({ atEnd: true, escaped: true, boundary: atBlockEnd }),
          ctx("A"),
        ),
      ).toEqual({ type: "markStep", marks: ["code"], escaped: false });
    });

    test("a SECOND ArrowRight leaves the block — the delimiter is spent", () => {
      expect(
        resolveKeystroke(
          "ArrowRight",
          NO_SHIFT,
          caret({ atEnd: true, escaped: true, boundary: atBlockEnd }),
          ctx("A"),
        ),
      ).toEqual({ type: "nav", dir: "right" });
    });

    test("ArrowLeft at the start of a leading marked run steps OUT (mirror image)", () => {
      expect(
        resolveKeystroke(
          "ArrowLeft",
          NO_SHIFT,
          caret({ atStart: true, boundary: atBlockStart }),
          ctx("B"),
        ),
      ).toEqual({ type: "markStep", marks: [], escaped: true });
      // ...and a second press then leaves the block.
      expect(
        resolveKeystroke(
          "ArrowLeft",
          NO_SHIFT,
          caret({ atStart: true, escaped: true, boundary: atBlockStart }),
          ctx("B"),
        ),
      ).toEqual({ type: "nav", dir: "left" });
    });

    test("the arrow pointing INTO the text is never the delimiter's", () => {
      // At `` `zz`| `` the delimiter is to the caret's right, so ArrowLeft is
      // ordinary character movement — it must not be consumed.
      expect(
        resolveKeystroke(
          "ArrowLeft",
          NO_SHIFT,
          caret({ atEnd: true, boundary: atBlockEnd }),
          ctx("A"),
        ),
      ).toEqual({ type: "passthrough" });
    });

    test("a marked run on the RIGHT of a seam gets a stop INSIDE it", () => {
      // The bug this rule replaced: `left ∩ right` is `{}` here, `natural`
      // already carries `{}`, so no stop was synthesized and the caret could
      // never sit inside the code run at its start.
      expect(
        resolveKeystroke(
          "ArrowRight",
          NO_SHIFT,
          caret({ boundary: markedRight }),
          ctx("A"),
        ),
      ).toEqual({ type: "markStep", marks: ["code"], escaped: true });
      // ...and the arrow pointing the other way is ordinary movement, as always.
      expect(
        resolveKeystroke(
          "ArrowLeft",
          NO_SHIFT,
          caret({ boundary: markedRight }),
          ctx("A"),
        ),
      ).toEqual({ type: "passthrough" });
    });

    test("...and one more press leaves the stop, so the seam still costs ONE press", () => {
      expect(
        resolveKeystroke(
          "ArrowRight",
          NO_SHIFT,
          caret({ escaped: true, boundary: markedRight }),
          ctx("A"),
        ),
      ).toEqual({ type: "passthrough" });
    });

    test("shift+Arrow never takes the mark stop, boundary or not", () => {
      // On the LAST line, so no span can be drawn either: the browser's.
      expect(
        resolveKeystroke(
          "ArrowRight",
          SHIFT,
          caret({ atEnd: true, boundary: atBlockEnd }),
          ctx("B"),
        ),
      ).toEqual({ type: "passthrough" });
    });
  });

  describe("deleting it", () => {
    test("Backspace after stepping out drops the mark from the run", () => {
      expect(
        resolveKeystroke(
          "Backspace",
          NO_SHIFT,
          caret({ atEnd: true, escaped: true, boundary: atBlockEnd }),
          ctx("A"),
        ),
      ).toEqual({
        type: "unmark",
        delimiter: { before: ["code"], after: [], residual: [] },
      });
    });

    test("Delete does it at the block START, where the delimiter is ahead", () => {
      expect(
        resolveKeystroke(
          "Delete",
          NO_SHIFT,
          caret({ atStart: true, escaped: true, boundary: atBlockStart }),
          ctx("B"),
        ),
      ).toEqual({
        type: "unmark",
        delimiter: { before: [], after: ["code"], residual: [] },
      });
    });

    test("a marked run on the RIGHT of a seam is stripped FORWARD", () => {
      // The strip walks outward from the seam, and this boundary's only mark is
      // on the side the anchor is NOT in — so a payload that named one direction
      // for the whole deletion would walk the plain run and strip nothing, i.e.
      // swallow the Backspace.
      expect(
        resolveKeystroke(
          "Backspace",
          NO_SHIFT,
          caret({ escaped: true, boundary: markedRight }),
          ctx("A"),
        ),
      ).toEqual({
        type: "unmark",
        delimiter: { before: [], after: ["code"], residual: [] },
      });
    });

    test("the WRONG key at each end falls straight through to today's ladder", () => {
      // Delete at the end of a trailing marked run: the delimiter is behind the
      // caret, so this is the ordinary forward-deletion ladder (B follows A).
      expect(
        resolveKeystroke(
          "Delete",
          NO_SHIFT,
          caret({ atEnd: true, escaped: true, boundary: atBlockEnd }),
          ctx("A"),
        ),
      ).toEqual({ type: "mergeNext" });
      // Backspace at the start of a leading marked run: ordinary merge.
      expect(
        resolveKeystroke(
          "Backspace",
          NO_SHIFT,
          caret({ atStart: true, escaped: true, boundary: atBlockStart }),
          ctx("B"),
        ),
      ).toEqual({ type: "merge" });
    });

    test("one press crosses the WHOLE boundary between two differently marked runs", () => {
      // Cap-1 applied consistently: the press lands in the RIGHT run's state,
      // not in a third state that neither run carries — and the deletion takes
      // both sides' marks off, leaving the shared residual (here, nothing).
      const seam: MarkBoundary = {
        left: ["bold"],
        right: ["code"],
        natural: ["bold"],
      };
      expect(
        resolveKeystroke(
          "ArrowRight",
          NO_SHIFT,
          caret({ boundary: seam }),
          ctx("A"),
        ),
      ).toEqual({ type: "markStep", marks: ["code"], escaped: true });
      expect(
        resolveKeystroke(
          "Backspace",
          NO_SHIFT,
          caret({ escaped: true, boundary: seam }),
          ctx("A"),
        ),
      ).toEqual({
        type: "unmark",
        delimiter: { before: ["bold"], after: ["code"], residual: [] },
      });
    });

    test("a mark SHARED by both runs survives the deletion and becomes the caret's", () => {
      // `` **a**|**`b`** `` — the code span nested inside a bold run. Only the
      // code delimiter is there to delete; the bold run is not being escaped.
      const nested: MarkBoundary = {
        left: ["bold"],
        right: ["bold", "code"],
        natural: ["bold"],
      };
      expect(
        resolveKeystroke(
          "ArrowRight",
          NO_SHIFT,
          caret({ boundary: nested }),
          ctx("A"),
        ),
      ).toEqual({ type: "markStep", marks: ["bold", "code"], escaped: true });
      expect(
        resolveKeystroke(
          "Backspace",
          NO_SHIFT,
          caret({ escaped: true, boundary: nested }),
          ctx("A"),
        ),
      ).toEqual({
        type: "unmark",
        delimiter: { before: [], after: ["code"], residual: ["bold"] },
      });
    });
  });

  describe("the `escaped` gate", () => {
    test("a caret at the same boundary that never stepped takes the ORDINARY ladder", () => {
      // The Cmd+E / autoformat / merge-landing case: the format diverges from the
      // node's bits, but no step was recorded, so Backspace deletes a character
      // (passthrough — not at the block start) rather than stripping the run.
      expect(
        resolveKeystroke(
          "Backspace",
          NO_SHIFT,
          caret({ atEnd: true, boundary: atBlockEnd }),
          ctx("A"),
        ),
      ).toEqual({ type: "passthrough" });
    });

    test("Backspace-at-start on a marked line still MERGES, exactly as before", () => {
      // The ladder below the new rung is byte-for-byte unchanged: B's previous
      // visible line is A, so this is the plain merge it has always been — the
      // leading mark run makes no difference at depth 0.
      expect(
        resolveKeystroke(
          "Backspace",
          NO_SHIFT,
          caret({ atStart: true, boundary: atBlockStart }),
          ctx("B"),
        ),
      ).toEqual({ type: "merge" });
    });

    test("a non-collapsed selection is never a delimiter deletion", () => {
      // Belt and braces: `readCaretContext` cannot produce this pair (its
      // `escaped` is already gated on `collapsed`), but the resolver is pure and
      // takes a plain struct, so it validates rather than trusting one producer.
      expect(
        resolveKeystroke(
          "Backspace",
          NO_SHIFT,
          caret({
            atEnd: true,
            collapsed: false,
            escaped: true,
            boundary: atBlockEnd,
          }),
          ctx("A"),
        ),
      ).toEqual({ type: "passthrough" });
    });

    test("a boundary with nothing to strip yields no deletion rung", () => {
      // Two identical runs are not a boundary at all — one state, nothing to
      // cross — so `virtualStop` is null and Backspace falls through even at
      // depth 1. (Reachable: `coalesce` splits on colour and link too.)
      const noDelimiter: MarkBoundary = {
        left: ["bold"],
        right: ["bold"],
        natural: ["bold"],
      };
      expect(
        resolveKeystroke(
          "Backspace",
          NO_SHIFT,
          caret({ atEnd: true, escaped: true, boundary: noDelimiter }),
          ctx("A"),
        ),
      ).toEqual({ type: "passthrough" });
    });
  });

  test("Enter and Tab never see the boundary — the linear offset is unaffected", () => {
    expect(
      resolveKeystroke(
        "Enter",
        NO_SHIFT,
        caret({ offset: 5, atEnd: true, escaped: true, boundary: atBlockEnd }),
        ctx("A"),
      ),
    ).toMatchObject({ type: "split", position: 5, asChild: true });
    expect(
      resolveKeystroke(
        "Tab",
        NO_SHIFT,
        caret({ escaped: true, boundary: atBlockEnd }),
        ctx("B"),
      ),
    ).toEqual({ type: "indent" });
  });
});

// ---------------------------------------------------------------------------
// Traversal symmetry: walking a `` `aaa`a `` block right-to-left must visit the
// same caret states left-to-right does, in reverse.
//
// A per-direction spot check is what let the original asymmetry through: the
// rightward path (`inside → stop → across`) was pinned, the leftward one was not,
// and ArrowLeft skipped the stop entirely because the browser's landing at a seam
// is always `natural` regardless of which side the caret came from.
//
// The block's caret states, left to right — two of the five linear offsets carry
// TWO states each, because a seam holds `natural` AND the virtual stop:
//
//   (0, escaped)  the block-START stop: outside the code run
//   (0, natural)  inside it, before the first `a`
//   (1) (2)       within `aaa`
//   (3, natural)  inside the code run, after the last `a`
//   (3, escaped)  the seam's stop: outside the code, before the plain `a`
//   (4)           after the plain `a`
//
// Both walks are driven by the real resolver over boundaries derived exactly as
// `$placeCaretAtLinearOffset` resolves them (a text/text seam biases to the END of
// the earlier run — measured, not assumed: `e2e/mark-boundary-verify.ts` phase 6
// reads the anchor and records it).
// ---------------------------------------------------------------------------

const CODE: Mark[] = ["code"];

interface Spot {
  offset: number;
  escaped: boolean;
}

/** A block's boundaries by linear offset (null = mid-run), and its last offset. */
type BoundaryMap = Record<number, MarkBoundary | null>;

const contextIn =
  (boundaries: BoundaryMap, last: number) =>
  (spot: Spot): CaretContext =>
    caret({
      offset: spot.offset,
      atStart: spot.offset === 0,
      atEnd: spot.offset === last,
      escaped: spot.escaped,
      boundary: boundaries[spot.offset] ?? null,
      stepLeftBoundary:
        spot.offset > 0 ? (boundaries[spot.offset - 1] ?? null) : null,
      stepRightBoundary:
        spot.offset < last ? (boundaries[spot.offset + 1] ?? null) : null,
    });

/**
 * Press `key` from `start` until the caret leaves the block, returning every
 * state it occupied. Each intent is applied exactly as the executor does:
 * `markStep` changes depth in place, `markArrive` moves AND lands escaped, a
 * passthrough is the browser's one-character move (which always lands at depth
 * 0 — the store cannot survive a caret move).
 */
function walkIn(
  boundaries: BoundaryMap,
  last: number,
  start: Spot,
  key: "ArrowLeft" | "ArrowRight",
): string[] {
  const contextAt = contextIn(boundaries, last);
  const step = key === "ArrowLeft" ? -1 : 1;
  let spot = start;
  const seen = [`${spot.offset}${spot.escaped ? "*" : ""}`];
  for (let guard = 0; guard < 12; guard++) {
    const intent = resolveKeystroke(key, NO_SHIFT, contextAt(spot), ctx("A"));
    if (intent.type === "markStep") spot = { ...spot, escaped: intent.escaped };
    else if (intent.type === "markArrive")
      spot = { offset: intent.offset, escaped: true };
    else if (intent.type === "passthrough")
      spot = { offset: spot.offset + step, escaped: false };
    else break; // nav — the caret left the block
    seen.push(`${spot.offset}${spot.escaped ? "*" : ""}`);
  }
  return seen;
}

describe("traversal symmetry", () => {
  /** Boundaries of `[{aaa,code},{a}]` at each linear offset (null = mid-run). */
  const BOUNDARIES: BoundaryMap = {
    // Block start: no earlier leaf, so the anchor is inside the code run and the
    // stop lies to its LEFT.
    0: { left: [], right: CODE, natural: CODE },
    1: null,
    2: null,
    // The seam: the `<=` bias resolves it to the END of the code run, so the
    // anchor is inside and the stop lies to its RIGHT.
    3: { left: CODE, right: [], natural: CODE },
    // Block end, after the plain run: nothing marked on either side.
    4: { left: [], right: [], natural: [] },
  };
  const LAST = 4;

  const contextAt = contextIn(BOUNDARIES, LAST);
  const walk = (start: Spot, key: "ArrowLeft" | "ArrowRight") =>
    walkIn(BOUNDARIES, LAST, start, key);

  test("rightward visits every state in order", () => {
    expect(walk({ offset: 0, escaped: true }, "ArrowRight")).toEqual([
      "0*", // the block-start stop
      "0", // inside the code run
      "1",
      "2",
      "3", // inside, at the seam
      "3*", // the seam's stop, outside
      "4",
    ]);
  });

  test("leftward visits the same states in reverse — the regression", () => {
    // Before the arrival rung, this walk read ["4","3","2","1","0","0*"]: the
    // press from 4 landed on `natural` at the seam, so `3*` was skipped and the
    // caret was INSIDE the code run one press earlier than the model says.
    expect(walk({ offset: LAST, escaped: false }, "ArrowLeft")).toEqual([
      "4",
      "3*", // the seam's stop is met FIRST coming from the right
      "3", // then inside
      "2",
      "1",
      "0",
      "0*", // and the block-start stop is met last
    ]);
  });

  test("the two walks are exact mirror images", () => {
    const rightward = walk({ offset: 0, escaped: true }, "ArrowRight");
    const leftward = walk({ offset: LAST, escaped: false }, "ArrowLeft");
    expect([...leftward].reverse()).toEqual(rightward);
  });

  test("an arrival whose stop is on the FAR side is left to the browser", () => {
    // Approaching the seam from the LEFT, `natural` is the nearer state and the
    // browser's own landing is already correct — the rung must not fire, or the
    // caret would jump the inside state going rightward.
    expect(
      resolveKeystroke(
        "ArrowRight",
        NO_SHIFT,
        contextAt({ offset: 2, escaped: false }),
        ctx("A"),
      ),
    ).toEqual({ type: "passthrough" });
    // The mirror: approaching block start from the right, `natural` is nearer.
    expect(
      resolveKeystroke(
        "ArrowLeft",
        NO_SHIFT,
        contextAt({ offset: 1, escaped: false }),
        ctx("A"),
      ),
    ).toEqual({ type: "passthrough" });
  });

  test("a delimiter still to cross HERE outranks one a step away", () => {
    // At the seam already escaped, ArrowLeft steps back INSIDE rather than
    // arriving somewhere new — `markStepFor` is ordered above `markArriveFor`.
    expect(
      resolveKeystroke(
        "ArrowLeft",
        NO_SHIFT,
        contextAt({ offset: 3, escaped: true }),
        ctx("A"),
      ),
    ).toEqual({ type: "markStep", marks: CODE, escaped: false });
  });

  test("stepping off a block edge is never an arrival", () => {
    // `stepLeftBoundary` is null at offset 0 by construction, so the boundary AT
    // the caret can never be re-read as its own destination and absorb the press
    // that is supposed to leave the block.
    expect(
      resolveKeystroke(
        "ArrowLeft",
        NO_SHIFT,
        contextAt({ offset: 0, escaped: true }),
        ctx("A"),
      ),
    ).toEqual({ type: "nav", dir: "left" });
    expect(
      resolveKeystroke(
        "ArrowRight",
        NO_SHIFT,
        contextAt({ offset: LAST, escaped: false }),
        ctx("A"),
      ),
    ).toEqual({ type: "nav", dir: "right" });
  });
});

// ---------------------------------------------------------------------------
// The MIRRORED block: `` a`aaa` `` — the marked run on the RIGHT of the seam.
//
// Same walk, opposite orientation, and the one the `left ∩ right` rule could not
// traverse at all. There, the seam's two states are `{}` (the browser's landing,
// on the plain run's end) and `{code}` (inside the code run at its start); the
// old rule computed the stop as `{}`, saw `natural` already carrying it, and
// synthesized nothing — so the state INSIDE the code span was unreachable and
// text could not be prepended into it. Rightward the walk simply lost a state;
// leftward the arrival rung had nothing to arrive at.
//
//   (0)           before the plain `a`
//   (1, natural)  after it, outside the code run
//   (1, escaped)  the seam's stop: INSIDE the code run, before its first `a`
//   (2) (3)       within `aaa`
//   (4, natural)  inside, after the last `a`
//   (4, escaped)  the block-end stop: outside the code run
// ---------------------------------------------------------------------------

describe("traversal symmetry, mirrored (the marked run on the RIGHT)", () => {
  /** Boundaries of `[{a},{aaa,code}]` at each linear offset (null = mid-run). */
  const BOUNDARIES: BoundaryMap = {
    // Block start, before the plain run: nothing marked on either side, so this
    // is not a boundary at all.
    0: { left: [], right: [], natural: [] },
    // The seam: the same END-of-the-earlier-run bias, which here puts the anchor
    // OUTSIDE the code run — so the stop is the state inside it, to the RIGHT.
    1: { left: [], right: CODE, natural: [] },
    2: null,
    3: null,
    // Block end: the anchor is inside the code run and the stop lies to its RIGHT.
    4: { left: CODE, right: [], natural: CODE },
  };
  const LAST = 4;
  const walk = (start: Spot, key: "ArrowLeft" | "ArrowRight") =>
    walkIn(BOUNDARIES, LAST, start, key);

  test("rightward stops INSIDE the code run at its start", () => {
    expect(walk({ offset: 0, escaped: false }, "ArrowRight")).toEqual([
      "0",
      "1", // outside the code run, at the seam
      "1*", // the seam's stop: inside it — typing here appends to the code run
      "2",
      "3",
      "4", // inside, at the block end
      "4*", // the block-end stop, outside
    ]);
  });

  test("leftward visits the same states in reverse", () => {
    expect(walk({ offset: LAST, escaped: true }, "ArrowLeft")).toEqual([
      "4*",
      "4",
      "3",
      "2",
      "1*", // the stop is met FIRST coming from the right — the arrival rung
      "1",
      "0",
    ]);
  });

  test("the two walks are exact mirror images", () => {
    const rightward = walk({ offset: 0, escaped: false }, "ArrowRight");
    const leftward = walk({ offset: LAST, escaped: true }, "ArrowLeft");
    expect([...leftward].reverse()).toEqual(rightward);
  });

  test("the seam still costs exactly ONE extra press in each direction", () => {
    // Cap 1: the stop is a single state, not one the caret can be trapped in.
    // Both walks visit 7 states across 5 offsets — the two seams contribute one
    // extra each, and nothing else does.
    expect(walk({ offset: 0, escaped: false }, "ArrowRight")).toHaveLength(
      LAST + 3,
    );
    expect(walk({ offset: LAST, escaped: true }, "ArrowLeft")).toHaveLength(
      LAST + 3,
    );
  });
});

test("unknown block id → passthrough", () => {
  expect(resolveKeystroke("Enter", NO_SHIFT, caret(), ctx("ghost"))).toEqual({
    type: "passthrough",
  });
});

// ---------------------------------------------------------------------------
// Zoomed: the editor shows one block (the root) and its descendants. The
// resolver sees only that view (`scopeNodes` — the root lifted to the top
// level) plus `scopeRootId`, and every ladder has to stay inside it.
// ---------------------------------------------------------------------------

describe("zoomed (scopeRootId)", () => {
  const r1 = Rank.between(null, null).toJSON();
  const r2 = Rank.between(Rank.from(r1), null).toJSON();
  const rankS = Rank.between(Rank.from(rankA), null).toJSON();

  /**
   *   page
   *   ├─ P ("parent")
   *   │  └─ R ("root")          ← the zoom root
   *   │     ├─ R1 ("one")
   *   │     └─ R2 ("two")
   *   │        └─ R2a ("deep")
   *   └─ S ("sibling")
   */
  function page(): BlockNode[] {
    return [
      mk("P", PAGE, rankA, { text: "parent", expanded: true }),
      mk("R", "P", rankChild, { text: "root", expanded: true }),
      mk("R1", "R", r1, { text: "one" }),
      mk("R2", "R", r2, { text: "two", expanded: true }),
      mk("R2a", "R2", rankChild, { text: "deep" }),
      mk("S", PAGE, rankS, { text: "sibling" }),
    ];
  }

  function zoomed(
    blockId: string,
    nodes = page(),
    rootId = "R",
  ): IntentContext {
    return {
      ...TYPE_FACTS,
      nodes: scopeNodes(nodes, rootId),
      scopeRootId: rootId,
      blockId,
    };
  }
  const whole = (blockId: string, nodes = page()): IntentContext => ({
    ...TYPE_FACTS,
    nodes,
    blockId,
  });

  test("Enter on the root nests its tail — a sibling would land outside", () => {
    for (const at of [
      caret({ offset: 2 }),
      caret({ offset: 4, atEnd: true }),
      caret({ offset: 0, atStart: true }),
    ]) {
      expect(
        resolveKeystroke("Enter", NO_SHIFT, at, zoomed("R")),
      ).toMatchObject({
        type: "split",
        asChild: true,
      });
    }
    // On the whole page the same mid-line Enter is a plain sibling split.
    expect(
      resolveKeystroke("Enter", NO_SHIFT, caret({ offset: 2 }), whole("R")),
    ).toMatchObject({ type: "split", asChild: false });
  });

  test("Backspace at the root's start goes nowhere — there is no line above in view", () => {
    const at = caret({ atStart: true });
    expect(resolveKeystroke("Backspace", NO_SHIFT, at, zoomed("R"))).toEqual({
      type: "nav",
      dir: "left",
    });
    // The whole page merges R up into its parent P.
    expect(resolveKeystroke("Backspace", NO_SHIFT, at, whole("R"))).toEqual({
      type: "merge",
    });
  });

  test("Backspace on the root's first child merges it INTO the root line", () => {
    expect(
      resolveKeystroke(
        "Backspace",
        NO_SHIFT,
        caret({ atStart: true }),
        zoomed("R1"),
      ),
    ).toEqual({ type: "merge" });
  });

  test("the root's last child is top level: no excess-indentation outdent out of the view", () => {
    // R2 with its child removed is the last visible line directly under R. On
    // the whole page it is excess-indented and would outdent out of R; zoomed,
    // R is the top level, so the line break above (R1) is what goes.
    const nodes = page().filter((n) => n.id !== "R2a");
    const at = caret({ atStart: true });
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, at, whole("R2", nodes)),
    ).toEqual({
      type: "outdent",
    });
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, at, zoomed("R2", nodes)),
    ).toEqual({ type: "merge" });
  });

  test("a line nested deeper than the root's children still outdents — inside the view", () => {
    expect(
      resolveKeystroke(
        "Backspace",
        NO_SHIFT,
        caret({ atStart: true }),
        zoomed("R2a"),
      ),
    ).toEqual({ type: "outdent" });
  });

  test("Delete at the end of the last line does not reach the block after the view", () => {
    const at = caret({ atEnd: true });
    expect(resolveKeystroke("Delete", NO_SHIFT, at, zoomed("R2a"))).toEqual({
      type: "nav",
      dir: "right",
    });
    // The whole page pulls S up into R2a.
    expect(resolveKeystroke("Delete", NO_SHIFT, at, whole("R2a"))).toEqual({
      type: "mergeNext",
    });
  });

  test("Shift+Tab on a root child has nowhere to go; Tab on the root has nothing to nest under", () => {
    expect(resolveKeystroke("Tab", SHIFT, caret(), zoomed("R1"))).toEqual({
      type: "noop",
    });
    expect(resolveKeystroke("Tab", SHIFT, caret(), whole("R1"))).toEqual({
      type: "outdent",
    });
    expect(resolveKeystroke("Tab", SHIFT, caret(), zoomed("R"))).toEqual({
      type: "noop",
    });
    expect(resolveKeystroke("Tab", NO_SHIFT, caret(), zoomed("R"))).toEqual({
      type: "noop",
    });
  });

  test("a zoomed CONTAINER is never unwrapped from its first line", () => {
    const k1 = Rank.between(null, null).toJSON();
    const k2 = Rank.between(Rank.from(k1), null).toJSON();
    const boxed: BlockNode[] = [
      { ...mk("CA", PAGE, rankA), type: "callout", expanded: true },
      mk("X", "CA", k1, { text: "first" }),
      mk("Y", "CA", k2, { text: "second" }),
    ];
    const at = caret({ atStart: true });
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, at, whole("X", boxed)),
    ).toEqual({ type: "unwrap", blockId: "CA" });
    // Dissolving the root would dissolve the view: the anchor owns no text and
    // nothing is above it, so the ladder ends at a plain caret move.
    expect(
      resolveKeystroke("Backspace", NO_SHIFT, at, zoomed("X", boxed, "CA")),
    ).toEqual({ type: "nav", dir: "left" });
    // Its first line is top level too: Shift+Tab takes it nowhere.
    expect(
      resolveKeystroke("Tab", SHIFT, caret(), zoomed("X", boxed, "CA")),
    ).toEqual({ type: "noop" });
  });
});
