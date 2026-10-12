// Document-level caret geometry for the block editor.
//
// Each block is its own Lexical editor, so caret movement ACROSS blocks can't
// rely on a single editor's line model. This module is the shared, low-level
// layer the coordinator uses:
//   - `readCaretContext` measures the caret in the SOURCE editor: its linear
//     offset, whether it sits at the structural start/end, whether it sits on
//     the first/last VISUAL line (so multi-line blocks only cross at their real
//     top/bottom), and its pixel column (so the column survives the crossing).
//   - `placeCaretAtColumn` / `placeCaretAtBoundary` place the caret in the
//     TARGET editor at that pixel column on the matching visual edge, or at the
//     block's very start/end (Left/Right crossing).
//
// Visual-line detection is font/padding-agnostic: it compares the caret rect to
// reference rects built at the contenteditable's content start/end, never to
// absolute padding. The DOM→Lexical placement uses `caretRangeFromPoint`
// (WebKit/Chrome) / `caretPositionFromPoint` (Firefox) and maps the hit DOM node
// to its Lexical node precisely (no reliance on async selectionchange).

import {
  $createRangeSelection,
  $getNearestNodeFromDOMNode,
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isElementNode,
  $isRangeSelection,
  $isRootNode,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type RangeSelection,
  type TextNode,
} from "lexical";
import {
  hasBox,
  selectionRange,
} from "@plugins/primitives/plugins/dom/plugins/dom-selection/web";
import { marksOfTextNode, type Mark } from "../../core";
import {
  $linearCaretOffset,
  $linearOffsetOfPoint,
  $paragraphsPlainLength,
  $placeCaretAtLinearOffset,
  $resolveLinearOffset,
} from "./block-text-extensions";
import {
  nextLeafInParagraph,
  prevLeafInParagraph,
} from "./inline-format-surgery";
import type { MarkBoundary } from "./mark-boundary";
import type { MarkDepthEntry } from "./mark-depth";

/** A snapshot of the caret in one block editor, consumed by the intent resolver. */
export interface CaretContext {
  /** Linear character offset across the block's paragraphs (split position). */
  offset: number;
  /** Whether the selection is collapsed (a caret, not a range). */
  collapsed: boolean;
  /** Structural: collapsed at offset 0 of the first paragraph. */
  atStart: boolean;
  /** Structural: collapsed at the end of the last paragraph. */
  atEnd: boolean;
  /** Visual: the caret sits on the block's first visual line. */
  onTopLine: boolean;
  /** Visual: the caret sits on the block's last visual line. */
  onBottomLine: boolean;
  /** Viewport x (px) of the caret — preserved when crossing up/down. */
  caretX: number;
  /**
   * The inline-mark boundary at the caret, or null when there is none (mid-run,
   * an unresolvable anchor, or a non-collapsed selection). See
   * `internal/mark-boundary.ts` for what a boundary implies.
   */
  boundary: MarkBoundary | null;
  /**
   * Has the caret already stepped past this boundary's virtual delimiter?
   *
   * TRUE ONLY after our own `markStep` recorded it and the live anchor still
   * verifies — never inferred from `selection.format`, which three shipped
   * mechanisms alias (see `internal/mark-depth.ts`). This flag is the gate the
   * whole feature's safety rests on.
   */
  escaped: boolean;
  /**
   * The mark boundary one caret step to the LEFT / RIGHT would land on, or null
   * when that step lands mid-run (the ordinary case) or off the block's edge.
   *
   * A seam holds TWO caret states — `natural` and the virtual stop — and which
   * one is correct depends on which side the caret ARRIVES from: nearest the
   * approach. The browser always delivers `natural`, so for one of the two
   * approaches it lands on the far state and the near one is skipped. Seeing the
   * destination is what lets the resolver own that press instead.
   */
  stepLeftBoundary: MarkBoundary | null;
  stepRightBoundary: MarkBoundary | null;
  /**
   * The selection's MOVING end — its focus — which is where Shift+Arrow
   * extends from. The fields above describe the ANCHOR end (`offset` is the
   * anchor's), which a range's extension never moves; a selection grown to a
   * block's edge by Shift+Arrow has its focus there while its anchor is still
   * mid-line. For a collapsed caret the two ends are one point and this
   * restates the caret.
   */
  focus: SelectionFocus;
}

/** Where a selection's focus sits — see {@link CaretContext.focus}. */
export interface SelectionFocus {
  /** Linear offset of the focus (stored-runs basis). */
  offset: number;
  /** Structural: the focus is at the block's very start / end. */
  atStart: boolean;
  atEnd: boolean;
  /** Visual: the focus is on the block's first / last visual line. */
  onTopLine: boolean;
  onBottomLine: boolean;
  /** Viewport x (px) of the focus. */
  x: number;
}

// --- structural reads -------------------------------------------------------
//
// The linear-offset model lives in `block-text-extensions` (the single source
// matching `splitRuns`/`textOf`/`serializeBlockRuns`). `readCaretContext`'s
// structural read derives offset / atStart / atEnd from `$linearCaretOffset()`
// and `$paragraphsPlainLength()` directly — no bespoke per-helper walk.

// --- mark boundary (inline format bits either side of the caret) ------------
//
// A boundary exists wherever the caret sits at a LEAF edge: the two runs meeting
// there may carry different marks, and the delimiter position between them is
// what `mark-boundary.ts` reasons about. Cost is one anchor read plus at most two
// sibling steps per keystroke — `readCaretContext` already does two full
// paragraph walks, so this is noise beside it.

/**
 * The marks a neighbouring leaf contributes to a boundary.
 *
 * Anything that is not a `TextNode` contributes none.
 *
 * `null` — the paragraph edge — is the block edge modelled as an empty unmarked
 * neighbour, which is what collapses block-start, block-end and mid-block into
 * one code path. A line break or a decorator answering `[]` is not a shortcut
 * either: `walkNode` in `core/runs-lexical.ts` emits BOTH as unmarked runs, so
 * the caret model and the persisted model cannot drift.
 */
function $leafMarks(leaf: LexicalNode | null): Mark[] {
  return leaf !== null && $isTextNode(leaf) ? marksOfTextNode(leaf) : [];
}

/**
 * Inside a Lexical READ: the mark boundary the collapsed caret stands on, or
 * `null` when it stands on none.
 *
 * Only leaf EDGES are boundaries; a caret in the middle of a run has the same
 * marks on both sides of it by definition. An empty `TextNode` satisfies both
 * edges at once, so its neighbours on both sides are the boundary's runs while
 * `natural` stays the node's own (possibly marked) bits.
 *
 * An ELEMENT anchor is a boundary too — the caret between two of the paragraph's
 * children, which is what a position beside an inline decorator or on an empty
 * soft line is. Its `natural` is `[]` because there is no text node to read bits
 * off, and `virtualStop` answers `null` for it: the caret has not
 * stepped out of either run, so there is no delimiter for it to have crossed.
 */
export function $readMarkBoundary(
  selection: RangeSelection,
): MarkBoundary | null {
  if (!selection.isCollapsed()) return null;
  const anchor = selection.anchor;
  if (anchor.type === "element") {
    const parent = anchor.getNode();
    if (!$isElementNode(parent)) return null;
    const children = parent.getChildren();
    return {
      left: $leafMarks(children[anchor.offset - 1] ?? null),
      right: $leafMarks(children[anchor.offset] ?? null),
      natural: [],
    };
  }
  const node = anchor.getNode();
  if (!$isTextNode(node)) return null;
  return $boundaryAtTextAnchor(node, anchor.offset);
}

/** The boundary at `within` inside the text leaf `node`, or null mid-run. */
function $boundaryAtTextAnchor(
  node: TextNode,
  within: number,
): MarkBoundary | null {
  const size = node.getTextContentSize();
  const atLeafStart = within === 0;
  const atLeafEnd = within === size;
  if (!atLeafStart && !atLeafEnd) return null;
  const natural = marksOfTextNode(node);
  return {
    left: atLeafStart ? $leafMarks(prevLeafInParagraph(node)) : natural,
    right: atLeafEnd ? $leafMarks(nextLeafInParagraph(node)) : natural,
    natural,
  };
}

/**
 * Inside a Lexical READ: the boundary a caret step to `offset` would LAND on.
 *
 * The caret's state at a seam depends on the direction it arrived from — the seam
 * has two states (`natural` and the virtual stop) and only one is correct for each
 * approach — but the browser always delivers the same one. So the resolver needs
 * to see the boundary at the DESTINATION, one step out, not only the one under the
 * caret.
 *
 * The destination is resolved through `$resolveLinearOffset`, the same walk
 * `$placeCaretAtLinearOffset` lands with. That shared resolver is what makes this
 * a LOOKAHEAD rather than a PREDICTION: the executor places the caret itself, so
 * the anchor this reads `natural` off is by construction the anchor the landing
 * produces. Nothing here guesses what Chromium would have chosen — and
 * `virtualStop` keeps deriving from a real anchor's real marks, which is
 * the property that made the design's one falsified assumption cost a test
 * expectation instead of a redesign.
 */
function $boundaryAtLinearOffset(offset: number): MarkBoundary | null {
  const resolved = $resolveLinearOffset(offset);
  if (resolved === null || "emptyParagraph" in resolved) return null;
  const { leaf, leafStart } = resolved;
  if (!$isTextNode(leaf)) return null;
  return $boundaryAtTextAnchor(leaf, offset - leafStart);
}

// --- visual geometry (DOM measurement) -------------------------------------
//
// Everything here is stated in LINE BOXES, never in "the caret's y vs. the
// editor's padded box". A block's soft lines are `<br>`-separated runs inside a
// single `<p>`, so the questions "am I on the first/last visual line" and "where
// is the target line" are answered by comparing the caret's line box to the
// first/last line box — a comparison that needs no epsilon, no padding
// arithmetic, and no computed line-height guess.
//
// The hard part is that a collapsed DOM Range answers `getClientRects()` with
// NOTHING for two positions that occur constantly in this editor:
//   - an EMPTY soft line (the caret sits between two `<br>`s), and
//   - the boundary beside an inline `contenteditable=false` decorator (a chip).
// The previous implementation read those as "no geometry" and substituted
// `{ onTopLine: true, onBottomLine: true }` — an absorbed failure that claims the
// caret is on BOTH edges, which is why ArrowUp/ArrowDown on any empty line inside
// a multi-line block jumped to the neighbouring BLOCK instead of the next line.
// Every rect read below therefore either returns a real box or returns null, and
// null propagates to a structural answer rather than a fabricated visual one.

/**
 * A rect the layout engine actually painted. A collapsed caret is 0-wide but
 * never 0-tall.
 *
 * The predicate itself is `hasBox` from `primitives/dom/dom-selection` — the one
 * statement of "a rect with no box is not an anchor", which this module used to
 * spell out inline and `format-toolbar-plugin` spelled out a second time. What
 * stays here is only the null-tolerance every caller below relies on.
 */
function usable(rect: DOMRect | null | undefined): DOMRect | null {
  if (!rect) return null;
  return hasBox(rect) ? rect : null;
}

/** The topmost (`first`) or bottommost (`last`) painted box among `rects`. */
function pickEdge(rects: DOMRectList, edge: "first" | "last"): DOMRect | null {
  const boxes = [...rects].filter((r) => usable(r));
  if (boxes.length === 0) return null;
  return boxes.reduce((best, r) =>
    edge === "first"
      ? r.top < best.top
        ? r
        : best
      : r.bottom > best.bottom
        ? r
        : best,
  );
}

/**
 * The line box at `node`'s `first`/`last` edge.
 *
 * A wrapped text node reports one client rect per line, so `pickEdge` selects the
 * right end of it. A `<br>` reports NO client rects at all while still occupying a
 * line — hence the bounding-rect fallback. Skipping that fallback is not a
 * cosmetic loss: the trailing `<br>` IS the last line of every block that ends in
 * an empty soft line, so without it the search fell through to the paragraph's
 * own box, whose vertical middle is a gap between two lines.
 *
 * Only ever called on LEAVES, so "the node's box" and "the node's line box" are
 * the same thing.
 */
function nodeLineRect(
  node: Node | null | undefined,
  edge: "first" | "last",
): DOMRect | null {
  if (!node) return null;
  const range = document.createRange();
  if (node.nodeType === Node.TEXT_NODE) range.selectNodeContents(node);
  else range.selectNode(node);
  return (
    pickEdge(range.getClientRects(), edge) ??
    usable(range.getBoundingClientRect()) ??
    (node.nodeType === Node.ELEMENT_NODE
      ? usable((node as Element).getBoundingClientRect())
      : null)
  );
}

/** Leaves of `node` in document order (`first`) or reverse (`last`). */
function* leavesFrom(node: Node, edge: "first" | "last"): Generator<Node> {
  if (!node.hasChildNodes()) {
    yield node;
    return;
  }
  const children = [...node.childNodes];
  if (edge === "last") children.reverse();
  for (const child of children) yield* leavesFrom(child, edge);
}

/**
 * The FIRST or LAST visual line box of `root`'s content.
 *
 * Walks in from the leading/trailing LEAF rather than collapsing a range at the
 * root's content edge: a collapsed range whose boundary sits between block-level
 * children paints nothing in Chromium, so the old `contentEdgeRect` returned null
 * for EVERY block here and the reference silently became the editor's padded box
 * — off by the padding at the top and by the padding at the bottom, in opposite
 * directions. A leaf is a `<span>`'s text, a `<br>`, or a decorator's own DOM,
 * each of which occupies exactly one line and reports it.
 *
 * Walking INWARD (rather than climbing back up to the parent) is what keeps the
 * answer a line: an unmeasurable trailing leaf hands off to the leaf before it,
 * still on the same edge, whereas the parent's box spans every line at once.
 */
function edgeLineRect(
  root: HTMLElement,
  edge: "first" | "last",
): DOMRect | null {
  for (const leaf of leavesFrom(root, edge)) {
    const rect = nodeLineRect(leaf, edge);
    if (rect) return rect;
  }
  return null;
}

/**
 * The line box the collapsed caret sits on, or null when the DOM cannot say.
 *
 * When the caret's own range paints nothing — an empty soft line, or the boundary
 * beside an inline decorator — the caret's line is BORROWED from the child node
 * at the anchor offset. That child is always on the caret's own line: the node
 * *at* the offset is what the caret sits immediately before (the `<br>` that ends
 * an empty line, the chip the caret sits in front of), and the node before it is
 * what the caret sits immediately after.
 *
 * Exported because it is also the ANCHOR READ for the pending-marks cue
 * (`components/format-toolbar-plugin.tsx`): the chip has to sit under the caret's
 * own line, and those two borrowing branches are exactly the positions a cue read
 * off the collapsed range alone gets wrong.
 */
export function caretLineRect(): DOMRect | null {
  // `selectionRange()` is the one home of the three-part guard (no selection →
  // `rangeCount === 0` → `getRangeAt(0)` throwing `IndexSizeError`); this read
  // used to carry the first two and not the third.
  const range = selectionRange();
  return range ? rangeLineRect(range) : null;
}

/**
 * The line box at the START of `range` — {@link caretLineRect}'s measurement,
 * for any range (the focus of a selection, built with {@link linearDomRange}),
 * with the same borrowing rules for a position that paints nothing.
 */
function rangeLineRect(range: Range): DOMRect | null {
  const direct = pickEdge(range.getClientRects(), "first");
  if (direct) return direct;

  const container = range.startContainer;
  if (container.nodeType !== Node.ELEMENT_NODE) return null;
  const children = container.childNodes;
  return (
    nodeLineRect(children[range.startOffset], "first") ??
    nodeLineRect(children[range.startOffset - 1], "last")
  );
}

/** Do two boxes sit on the same visual line? Vertical overlap — no epsilon needed. */
function sameLine(a: DOMRect, b: DOMRect): boolean {
  return a.top < b.bottom && a.bottom > b.top;
}

/**
 * Where the caret sits among `root`'s visual lines, or null when the caret has no
 * measurable line box at all (a genuinely empty block, or an unfocused editor).
 * Null is the honest answer — the caller substitutes the STRUCTURAL edges, which
 * for a block with no lines to speak of are the same thing.
 */
function measureVisualLines(
  root: HTMLElement,
): Pick<CaretContext, "onTopLine" | "onBottomLine" | "caretX"> | null {
  const caret = caretLineRect();
  if (!caret) return null;
  const first = edgeLineRect(root, "first");
  const last = edgeLineRect(root, "last");
  return {
    // An unmeasurable extent with a measurable caret means the caret IS the only
    // line there is to be on.
    onTopLine: first ? sameLine(caret, first) : true,
    onBottomLine: last ? sameLine(caret, last) : true,
    caretX: caret.left,
  };
}

/**
 * Measure the caret in `editor`. Returns null when there is no caret to measure:
 * no range selection, or an anchor the linear-offset model cannot resolve. Null
 * is the ONLY "I don't know" — the offset and the `atStart`/`atEnd` flags are
 * always derived from the same resolved number, never from a substituted default
 * that would make them contradict each other (an unresolved anchor used to read
 * as `offset: 0` AND `atStart: false`, so every structural keystroke silently
 * degraded to a passthrough).
 *
 * `depth` is the caller's recorded mark-delimiter step (`readMarkDepth`), passed
 * IN rather than read here so this module keeps no module state of its own. It is
 * verified against the live anchor inside the same read — an entry only counts
 * while the selection is still collapsed at exactly the position it was taken at,
 * which is what makes a stale entry structurally impossible.
 */
export function readCaretContext(
  editor: LexicalEditor,
  depth: MarkDepthEntry | null = null,
): CaretContext | null {
  const structural = editor.getEditorState().read(
    (): {
      offset: number;
      focusOffset: number;
      focusAtStart: boolean;
      focusAtEnd: boolean;
      collapsed: boolean;
      atStart: boolean;
      atEnd: boolean;
      boundary: MarkBoundary | null;
      escaped: boolean;
      stepLeftBoundary: MarkBoundary | null;
      stepRightBoundary: MarkBoundary | null;
    } | null => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) return null;
      // One walk each for the offset and the total; derive start/end from them.
      const off = $linearCaretOffset();
      if (off === null) return null;
      const total = $paragraphsPlainLength();
      const collapsed = selection.isCollapsed();
      const anchor = selection.anchor;
      const focusOff = collapsed
        ? off
        : ($linearOffsetOfPoint(selection.focus) ?? off);
      return {
        offset: off,
        focusOffset: focusOff,
        focusAtStart: focusOff === 0,
        focusAtEnd: focusOff === total,
        collapsed,
        atStart: collapsed && off === 0,
        atEnd: collapsed && off === total,
        boundary: $readMarkBoundary(selection),
        escaped:
          collapsed &&
          depth !== null &&
          anchor.key === depth.anchorKey &&
          anchor.offset === depth.anchorOffset,
        // Only INSIDE the block: a step off either edge is a cross-block move, and
        // clamping would otherwise re-read the caret's own position as its own
        // destination — which would let a boundary at offset 0 absorb the ArrowLeft
        // that is supposed to leave the block.
        stepLeftBoundary:
          collapsed && off > 0 ? $boundaryAtLinearOffset(off - 1) : null,
        stepRightBoundary:
          collapsed && off < total ? $boundaryAtLinearOffset(off + 1) : null,
      };
    },
  );
  if (!structural) return null;
  const { focusOffset, focusAtStart, focusAtEnd, ...anchorSide } = structural;

  const root = editor.getRootElement();
  const visual = root ? measureVisualLines(root) : null;
  // No measurable caret line box (no root element, or a block with no painted
  // content). Fall back to the STRUCTURAL edges rather than to `true`/`true`:
  // "the caret is on the first visual line" is exactly "the caret is at the
  // start" once there is at most one line, and it is never a claim that the
  // caret is simultaneously on the first AND last line of a block that has
  // several.
  const caretSide = visual ?? {
    onTopLine: structural.atStart,
    onBottomLine: structural.atEnd,
    caretX: root?.getBoundingClientRect().left ?? 0,
  };
  const focusLines = structural.collapsed
    ? caretSide
    : (measureFocusLines(editor, root, focusOffset) ?? {
        onTopLine: focusAtStart,
        onBottomLine: focusAtEnd,
        caretX: caretSide.caretX,
      });
  return {
    ...anchorSide,
    ...caretSide,
    focus: {
      offset: focusOffset,
      atStart: focusAtStart,
      atEnd: focusAtEnd,
      onTopLine: focusLines.onTopLine,
      onBottomLine: focusLines.onBottomLine,
      x: focusLines.caretX,
    },
  };
}

/**
 * {@link measureVisualLines} for a selection's FOCUS rather than its start:
 * the line box at linear `offset`, measured off a Range built there (the
 * paint-side resolver, {@link linearDomRange}) — the document selection's own
 * range starts at whichever end comes first, which for a forward selection is
 * the anchor.
 */
function measureFocusLines(
  editor: LexicalEditor,
  root: HTMLElement | null,
  offset: number,
): Pick<CaretContext, "onTopLine" | "onBottomLine" | "caretX"> | null {
  if (!root) return null;
  const range = linearDomRange(editor, offset, offset);
  const focus = range ? rangeLineRect(range) : null;
  if (!focus) return null;
  const first = edgeLineRect(root, "first");
  const last = edgeLineRect(root, "last");
  return {
    onTopLine: first ? sameLine(focus, first) : true,
    onBottomLine: last ? sameLine(focus, last) : true,
    caretX: range?.getClientRects()[0]?.left ?? focus.left,
  };
}

// --- caret placement (target editor) ---------------------------------------

interface DomCaret {
  node: Node;
  offset: number;
}

/**
 * Lexical's `skip-scroll-into-view` update tag: suppresses the
 * `scrollIntoViewIfNeeded` that `updateDOMSelection` otherwise runs on every
 * collapsed-selection reconcile. Passed on the no-scroll path.
 *
 * Exported for the one caller that is ALREADY inside an update and therefore
 * cannot go through {@link placeCaretAtOffset} — it pairs the tag with
 * {@link $placeCaretAtOffset} to reconstruct exactly this module's no-scroll
 * landing.
 */
export const SKIP_SCROLL_TAG = "skip-scroll-into-view";

/**
 * Take DOM focus for a caret landing. A no-scroll landing focuses the ROOT
 * element with `preventScroll` (Lexical's `editor.focus()` has no such option —
 * it always lets the browser scroll focus into view); a scroll-wanted landing
 * keeps `editor.focus()`, today's behavior.
 */
function focusEditor(editor: LexicalEditor, scroll: boolean): void {
  if (scroll) editor.focus();
  else editor.getRootElement()?.focus({ preventScroll: true });
}

/** Cross-browser caret hit-test: WebKit/Chrome `caretRangeFromPoint`, Firefox `caretPositionFromPoint`. */
function caretFromPoint(x: number, y: number): DomCaret | null {
  const doc = document as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };
  if (typeof doc.caretRangeFromPoint === "function") {
    const r = doc.caretRangeFromPoint(x, y);
    if (r) return { node: r.startContainer, offset: r.startOffset };
  }
  if (typeof doc.caretPositionFromPoint === "function") {
    const p = doc.caretPositionFromPoint(x, y);
    if (p) return { node: p.offsetNode, offset: p.offset };
  }
  return null;
}

/**
 * Focus `editor` and place a collapsed caret at the linear `offset` (the stored-
 * runs plain-text basis read by `$linearCaretOffset`). The walk is leaf-aware, so
 * a mixed-format paragraph lands the caret at the right run/decorator boundary —
 * used to land the caret at the JOIN point after a Backspace-merge. The offset is
 * clamped to the block's total plain length.
 *
 * `scroll` (default false) declares whether the landing follows the caret into
 * view: false focuses via `preventScroll` and tags the update `skip-scroll-into-
 * view`; true is today's scroll-on behavior.
 */
export function placeCaretAtOffset(
  editor: LexicalEditor,
  offset: number,
  scroll = false,
): void {
  focusEditor(editor, scroll);
  editor.update(
    () => $placeCaretAtOffset(offset),
    scroll ? undefined : { tag: SKIP_SCROLL_TAG },
  );
}

/**
 * Inside an editor update: collapse the caret to the linear `offset` across the
 * block's paragraphs (the body of `placeCaretAtOffset`, delegating to the shared
 * leaf-walking primitive). Exposed so a caller already inside an `editor.update()`
 * can restore the caret without nesting an update.
 */
export function $placeCaretAtOffset(offset: number): void {
  $placeCaretAtLinearOffset(offset);
}

/**
 * Focus `editor` and collapse the caret to the very start or end of its content.
 * `scroll` (default false) declares whether the landing follows the caret into
 * view — see {@link placeCaretAtOffset}.
 */
export function placeCaretAtBoundary(
  editor: LexicalEditor,
  edge: "start" | "end",
  scroll = false,
): void {
  focusEditor(editor, scroll);
  editor.update(
    () => {
      const root = $getRoot();
      if (edge === "start") root.selectStart();
      else root.selectEnd();
    },
    scroll ? undefined : { tag: SKIP_SCROLL_TAG },
  );
}

/**
 * Translate a DOM hit-test result `(element, childOffset)` into the equivalent
 * child index inside the Lexical element `node`.
 *
 * The DOM offset names a child NODE, so the translation goes through that child:
 * resolve it back to its Lexical node and read its index. Falls back to the end
 * of the element when the offset points past the last child (a caret at the very
 * end of the line), and to 0 when nothing resolves.
 *
 * Must be called inside an `editor.update()` / `read()`.
 */
function $childIndexAtDomOffset(node: ElementNode, hit: DomCaret): number {
  const size = node.getChildrenSize();
  if (hit.node.nodeType !== Node.ELEMENT_NODE) return 0;
  const domChild = hit.node.childNodes[hit.offset];
  if (!domChild) return size;

  // The DOM child may be a DESCENDANT's element (an inner span of a decorator's
  // React tree), so climb to the direct child of `node`.
  let current: LexicalNode | null = $getNearestNodeFromDOMNode(domChild);
  while (current && current.getParent()?.getKey() !== node.getKey()) {
    current = current.getParent();
  }
  if (current) return current.getIndexWithinParent();

  // Nothing resolved: the DOM child carries no Lexical key of its own, which is
  // the case for a LineBreakNode's `<br>` — so `$getNearestNodeFromDOMNode`
  // answers the PARAGRAPH, whose climb terminates at the root and yields no
  // child. That is precisely the node an empty soft line is made of, so the
  // fallback matters: positionally, the DOM child list and the Lexical child
  // list are the same list (one DOM node per inline child), so the hit offset IS
  // the index.
  return Math.min(Math.max(hit.offset, 0), size);
}

/**
 * The linear offset (stored-runs basis) of the insertion point under the
 * viewport point `(x, y)` inside `editor`'s content, WITHOUT moving any caret —
 * where a drop at that point would land its text. Null when the point resolves
 * outside this editor's root, or onto a node no linear offset describes (the
 * root itself, which is a padded box rather than a position in the text).
 *
 * The same hit-test and the same Lexical-node translation `placeCaretAtColumn`
 * lands a caret with, read instead of applied: a text hit is that text node's
 * offset, a decorator hit is the side of the chip the point fell on, an element
 * hit (an empty soft line) is the child index its DOM offset names.
 */
export function linearOffsetAtPoint(
  editor: LexicalEditor,
  x: number,
  y: number,
): number | null {
  const root = editor.getRootElement();
  const hit = caretFromPoint(x, y);
  if (!root || !hit || !root.contains(hit.node)) return null;
  // `editor.read`, not `getEditorState().read`: the DOM → node lookup needs
  // this editor ACTIVE, and only the former makes it so.
  return editor.read(() => {
    const node = $getNearestNodeFromDOMNode(hit.node);
    if (!node || $isRootNode(node)) return null;
    const point = $createRangeSelection().anchor;
    if ($isTextNode(node)) {
      point.set(
        node.getKey(),
        Math.min(hit.offset, node.getTextContentSize()),
        "text",
      );
      return $linearOffsetOfPoint(point);
    }
    const parent = node.getParent();
    if ($isElementNode(node)) {
      point.set(node.getKey(), $childIndexAtDomOffset(node, hit), "element");
      return $linearOffsetOfPoint(point);
    }
    // A leaf that is not text (a decorator chip, a line break): an element
    // point in its parent, before or after it by the side the point fell on.
    if (!parent) return null;
    const box = (
      hit.node.nodeType === Node.ELEMENT_NODE
        ? (hit.node as Element)
        : hit.node.parentElement
    )?.getBoundingClientRect();
    const after = !box || x > (box.left + box.right) / 2;
    const index = node.getIndexWithinParent() + (after ? 1 : 0);
    point.set(parent.getKey(), index, "element");
    return $linearOffsetOfPoint(point);
  });
}

/**
 * The linear offset (stored-runs basis) of the editor's native selection
 * ANCHOR, or null when it holds no range selection. Reads only.
 */
export function nativeAnchorLinearOffset(editor: LexicalEditor): number | null {
  return editor.read(() => {
    const selection = $getSelection();
    if (!$isRangeSelection(selection)) return null;
    return $linearOffsetOfPoint(selection.anchor);
  });
}

/**
 * The DOM `Range` over linear `[from, to)` of the editor's text, both ends
 * clamped into the content it holds now — the paint-side dual of
 * {@link linearOffsetAtPoint}. Reads only: it builds a detached Range and
 * touches no selection, which is what lets an editor-owned span be painted
 * across several editing hosts at once (no native selection can).
 *
 * Each end resolves through `$resolveLinearOffset`, the SAME resolver the
 * caret's placement uses, so a painted end and a caret landed at that offset
 * sit at one DOM position.
 */
export function linearDomRange(
  editor: LexicalEditor,
  from: number,
  to: number,
): Range | null {
  const root = editor.getRootElement();
  if (!root) return null;
  return editor.read(() => {
    const total = $paragraphsPlainLength();
    const lo = Math.max(0, Math.min(from, to, total));
    const hi = Math.max(lo, Math.min(Math.max(from, to), total));
    const start = $domPointAtLinearOffset(editor, lo);
    const end = $domPointAtLinearOffset(editor, hi);
    if (!start || !end) return null;
    const range = root.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  });
}

/** The DOM position of an already-clamped linear `offset`, inside a read. */
function $domPointAtLinearOffset(
  editor: LexicalEditor,
  offset: number,
): { node: Node; offset: number } | null {
  const resolved = $resolveLinearOffset(offset);
  if (resolved === null) return null;
  if ("emptyParagraph" in resolved) {
    const el = editor.getElementByKey(resolved.emptyParagraph.getKey());
    return el ? { node: el, offset: 0 } : null;
  }
  const { leaf, leafStart } = resolved;
  const el = editor.getElementByKey(leaf.getKey());
  if (!el) return null;
  if ($isTextNode(leaf)) {
    // A text node renders as an element (nested once per format tag) around
    // ONE DOM text node holding its characters.
    const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode() as Text | null;
    if (!text) return { node: el, offset: 0 };
    return {
      node: text,
      offset: Math.max(0, Math.min(offset - leafStart, text.length)),
    };
  }
  // An atomic leaf (a chip, a line break): before or after its element.
  const parent = el.parentNode;
  if (!parent) return null;
  const index = Array.prototype.indexOf.call(parent.childNodes, el) as number;
  return { node: parent, offset: index + (offset > leafStart ? 1 : 0) };
}

/**
 * Focus `editor` and place the caret at viewport column `x` on its top or bottom
 * visual line — preserving the column when crossing blocks up/down. Falls back to
 * the block start/end when the point resolves outside the editor.
 *
 * `scroll` (default false) declares whether the landing follows the caret into
 * view — see {@link placeCaretAtOffset}. It is threaded through both boundary
 * fallbacks and the hit-test placement so EVERY selection-setting update on this
 * path honors the intent.
 */
export function placeCaretAtColumn(
  editor: LexicalEditor,
  x: number,
  edge: "top" | "bottom",
  scroll = false,
): void {
  const root = editor.getRootElement();
  if (!root) {
    placeCaretAtBoundary(editor, edge === "top" ? "start" : "end", scroll);
    return;
  }
  focusEditor(editor, scroll);

  const rootRect = root.getBoundingClientRect();
  // Aim at the CENTRE of the target line box, not at an offset from the editor's
  // padded box. A block whose last line is empty has its `<br>` line box well
  // above `rootRect.bottom`, so the old arithmetic aimed into the bottom padding:
  // the hit-test then resolved to the root element, `$getNearestNodeFromDOMNode`
  // answered the RootNode, and the "element anchor at offset 0" branch below
  // landed the caret at the very START of the block — which is why arrowing UP
  // into a multi-line block jumped to its first line instead of its last.
  const line = edgeLineRect(root, edge === "top" ? "first" : "last");
  const y = line
    ? (line.top + line.bottom) / 2
    : edge === "top"
      ? rootRect.top + 1
      : rootRect.bottom - 1;
  const clampedX = Math.min(Math.max(x, rootRect.left + 1), rootRect.right - 1);

  const hit = caretFromPoint(clampedX, y);
  if (!hit || !root.contains(hit.node)) {
    placeCaretAtBoundary(editor, edge === "top" ? "start" : "end", scroll);
    return;
  }

  editor.update(
    () => {
      const landAtBoundary = () => {
        const root2 = $getRoot();
        if (edge === "top") root2.selectStart();
        else root2.selectEnd();
      };
      const node = $getNearestNodeFromDOMNode(hit.node);
      if (!node) {
        landAtBoundary();
        return;
      }
      if ($isTextNode(node)) {
        const off = Math.min(hit.offset, node.getTextContentSize());
        const sel = $createRangeSelection();
        sel.anchor.set(node.getKey(), off, "text");
        sel.focus.set(node.getKey(), off, "text");
        $setSelection(sel);
        return;
      }
      // A DECORATOR hit — the point landed on a chip / inline formula / inline
      // page link. An element-typed selection point on a decorator is not a caret
      // position at all: Lexical has nowhere to paint it, so the caret would
      // simply vanish. Land beside the decorator instead, preferring the side the
      // point actually fell on.
      if ($isDecoratorNode(node)) {
        const hitRect = (
          hit.node.nodeType === Node.ELEMENT_NODE
            ? (hit.node as Element)
            : hit.node.parentElement
        )?.getBoundingClientRect();
        const after = !hitRect || clampedX > (hitRect.left + hitRect.right) / 2;
        const landed = after
          ? (node.selectNext(0, 0) ?? node.selectPrevious())
          : (node.selectPrevious() ?? node.selectNext(0, 0));
        if (!landed) landAtBoundary();
        return;
      }
      // The RootNode is not a landing site either: "element offset 0" on it is
      // the very start of the block, which for a `bottom` landing is the opposite
      // of what was asked for.
      if ($isRootNode(node) || !$isElementNode(node)) {
        // A non-element leaf (a `<br>`'s LineBreakNode) is not addressable as an
        // element point either — land beside it.
        const landed = $isRootNode(node)
          ? null
          : (node.selectNext(0, 0) ?? node.selectPrevious());
        if (!landed) landAtBoundary();
        return;
      }
      // An ELEMENT hit — the point fell between the paragraph's children rather
      // than inside a text run, which is what an EMPTY soft line is (the caret
      // position between two `<br>`s). The DOM offset is the whole answer here
      // and must be carried across: pinning the selection to element offset 0
      // landed every such hit at the block's FIRST line, which is why arrowing UP
      // into a block whose last line is empty jumped to its top. The DOM offset is
      // translated through the child it names rather than used as a Lexical index
      // directly — the two agree today, but only the mapping is guaranteed to.
      const sel = $createRangeSelection();
      const index = $childIndexAtDomOffset(node, hit);
      sel.anchor.set(node.getKey(), index, "element");
      sel.focus.set(node.getKey(), index, "element");
      $setSelection(sel);
    },
    scroll ? undefined : { tag: SKIP_SCROLL_TAG },
  );
}
