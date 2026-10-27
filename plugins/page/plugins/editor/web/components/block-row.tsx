import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { useMemo, type ComponentType, type CSSProperties } from "react";
import { useDroppable } from "@dnd-kit/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import type { DropZone } from "@plugins/primitives/plugins/tree/core";
import type { Block } from "../../core";
import type { BlockAnchorProps, BlockEditorAPI } from "../types";
import { useBlockEditor } from "../block-editor-context";
import { useSelectionControl } from "../selection-control";
import { Editor, useBlockDecorations } from "../slots";
import { BlockRail } from "./block-rail";
import { BlockCaretHost } from "./void-caret";
import {
  BLOCK_INDENT,
  blockContentLeft,
  frameBoxLeft,
  framePadX,
  framePadY,
} from "../internal/page-column";
import { gutterFirstLineCenter, type RailSeat } from "../internal/rail-seat";
import {
  hasTextLeftToSelect,
  isSelectAllKey,
} from "../internal/select-all-ladder";
import "./block-document-scale.css";

/** One empty body line plus the standard row padding — the childless-anchor box. */
const ONE_EMPTY_LINE = "calc(var(--space-xs) * 2 + var(--doc-lh-body))";

// The anchor decoration's own column. The `absolute` is deliberate and has no
// primitive: the column is positioned via JS coords (style left/width at the use
// site), and `.block-anchor` owns the borrowed-first-line vertical seat.
//
// This used to be hoisted in order to HIDE from `layout/no-adhoc-layout` — the
// note said so, because the only escape was a positional directive inside a JSX
// attribute that a format pass could displace. Both halves of that are gone: the
// `lint-directives-stable` check now refuses to write a file whose directives
// formatting would displace, and the shared class-token walk follows a same-file
// const, so hoisting hides nothing. The exemption is written at the use site.
const ANCHOR_COLUMN = "block-anchor absolute z-raised";

// The CORNER seat: the card's name, pinned INSIDE the top-right corner of the box
// the frame paints — one pad in on each axis, which is where the box's own content
// starts, so the name lines up with the text under it on both edges. Above the
// frame and in the row layer so it can be clicked. It floats OVER the content: it
// reserves no space and shifts nothing, which is the point — at rest there is
// nothing there at all, and pointing at the card is what asks.
//
// No `.block-anchor` (that class carries the borrowed-first-line vertical seat,
// which is exactly what this seat does NOT want) and no width: a name is as wide
// as it reads.
const CORNER_COLUMN = "absolute z-raised";

// The selection marker: a selected block SAYS "Selected." to a screen reader,
// because it has no attribute with which to be selected.
//
// `aria-selected` is supported only on `option`, `row`, `gridcell`, `tab`,
// `treeitem`, `columnheader` and `rowheader` — and none of those may host a
// `contenteditable`, which every row here does. So the state has no native
// carrier and becomes a word instead. `sr-only` is `position: absolute`, so it
// perturbs no rect that drag, drop or the marquee measures.
//
// Rendered ALWAYS, empty when unselected, never mounted conditionally: the row's
// children list must keep a constant length (the fiber-index pairing hazard
// `text-block-layout.tsx` documents). The full rationale — and why `role="option"`
// must not be re-added — is in this plugin's `CLAUDE.md`, under
// *The block list is a document, not a listbox*.
function SelectionMarker({ isSelected }: { isSelected: boolean }) {
  return <span className="sr-only">{isSelected ? "Selected. " : ""}</span>;
}

/**
 * Renders whichever decoration the container's frame registration supplied, in
 * whichever seat the surface put it. It exists so the two seats dispatch through
 * ONE call site: a seat is a position, never a different contract, and a second
 * spelling here is how one of them would quietly grow a prop the other lacks.
 */
function AnchorDecoration({
  component: Decoration,
  block,
  editor,
}: {
  component: ComponentType<BlockAnchorProps>;
  block: Block;
  editor: BlockEditorAPI;
}) {
  // Not a component CREATED during render: `Decoration` arrives as a prop, from
  // a registry LOOKUP into the memoized `useBlockDecorations()` map whose values
  // are module-level slot contributions. Its identity is stable across renders,
  // so no state below it can reset.
  return (
    <Decoration
      type={block.type}
      data={block.data}
      blockId={block.id}
      editor={editor}
    />
  );
}

// The column geometry (rail width, per-depth indent, content inset) lives in
// `../internal/page-column` — see its module doc for the invariant. Hosts align
// their own chrome onto the block content edge via `PageContentColumn`, never by
// re-deriving it from `BLOCK_GUTTER`.

export function BlockRow({
  block,
  depth,
  hasVisibleChildren,
  ordinal,
  isDragging,
  isSelected,
  dropZone,
  seat,
}: {
  block: Block;
  depth: number;
  /** Whether this block's children are currently rendered below this row. */
  hasVisibleChildren: boolean;
  /** 1-based position within the consecutive run of same-type siblings (ordinal-marker blocks). */
  ordinal: number;
  isDragging: boolean;
  /**
   * Whether this block is in the current block selection. Handed down by the
   * editor, which already holds `selectedIds` — NOT read from the selection store
   * here, which would newly subscribe every row to it. The editor re-renders every
   * row on a selection change anyway (it recomputes the selection bands), so the
   * prop is free and the subscription would not be.
   *
   * The row paints nothing for it. Selection is a decoration over the RUN of
   * selected lines, and the only thing this adds is the `sr-only` word below.
   */
  isSelected: boolean;
  /** Where the dragged block would land relative to this row, or null. */
  dropZone: DropZone | null;
  /**
   * This row's resolved RAIL SEAT: where the hover controls sit, which block
   * they act on, and — for a container anchor — the first-line center it borrows
   * from its first child. Resolved by the editor with the whole flatten in view
   * (`internal/rail-seat.ts`), because neither the geometry (a row's outermost
   * enclosing FRAME) nor the ownership (the borrow chain above it) is knowable
   * from a row alone. The row hands it straight to `<BlockRail>` without reading
   * the owner: keeping `block` and `seat.owner` apart in separate components is
   * what makes a control targeting the wrong block unwriteable.
   */
  seat: RailSeat;
}) {
  const { focusedBlockId, makeBlockAPI, loadingBelow, failedBelow } =
    useBlockEditor();
  const api = useMemo(() => makeBlockAPI(block.id), [makeBlockAPI, block.id]);
  const isFocused = focusedBlockId === block.id;
  const belowFailure = failedBelow.get(block.id);
  const selection = useSelectionControl();

  const contributions = Editor.Block.useContributions();
  const registration = contributions.find((c) => c.block.type === block.type);
  const handle = registration?.block;
  // Who holds this row's caret. A type that declares `caret: "renderer"` owns
  // one already (a textarea, a `Row`'s inner control); EVERY other row gets the
  // editor's host, including a type with no registration at all — which is the
  // `unknown` fallback, and is deliberately the fail-safe direction: a block the
  // editor does not recognise is still reachable, still deletable, and still
  // says where the caret is. (Text-bearing rows never reach here with a `caret`
  // — the field is `never` on their arm — but they are excluded anyway by the
  // `acceptsText` test, since their Lexical instance is the host.)
  const editorHoldsCaret =
    handle?.acceptsText !== true && registration?.caret !== "renderer";
  const decorations = useBlockDecorations();
  const decoration = decorations.get(block.type);

  // One droppable per row; the editor's drag handler resolves before/after/child
  // from the pointer's position within this rect (single target → single line).
  // Drop targets stay strictly per-row — only the RAIL's controls follow the
  // seat's owner, so a drop still lands relative to the line under the pointer.
  const { setNodeRef: setDropRef } = useDroppable({ id: block.id });

  // Left edge of this row's content, measured from the row's own border box.
  // The gutter rail lives in the row's padding, so every offset is relative to
  // the row; the rail's own controls hang back from `seat.left` (this row's
  // content edge, or its enclosing frame's), which is the rail's business, not
  // this row's. A drop lands as a sibling of this row, so the line sits at this
  // row's depth.
  // The row's own content edge, pulled back by every frame that has absorbed its
  // indent step to spend as padding instead (`FRAME_PAD_X`).
  const contentLeft = blockContentLeft(depth, seat.absorbedIndent);
  // Measured from the row's own border edge, so any card padding reserved ABOVE
  // this row's first line has to be added — otherwise the rail's buttons seat in
  // the card's top padding instead of beside the line they act on.
  const firstLineCenter = `calc(${framePadY(seat.firstLinePad)} + ${
    seat.borrowedFirstLineCenter ?? gutterFirstLineCenter(handle)
  })`;

  const dropIndicator = (zone: DropZone) => (
    <div
      // eslint-disable-next-line layout/no-adhoc-layout -- drop indicator positioned via JS-computed left coord (style below) + right-1/top-0/bottom-0 edge pins; not a ramp-expressible anchor
      className={cn(
        "bg-primary pointer-events-none absolute right-1 z-raised h-[2px] rounded-full",
        zone === "before" ? "top-0" : "bottom-0",
      )}
      style={{ left: contentLeft + 4 }}
    >
      {/* eslint-disable-next-line layout/no-adhoc-layout -- decorative endpoint dot offset onto the line via fractional negative coords */}
      <div className="bg-primary absolute -left-1 -top-[3px] size-2 rounded-full" />
    </div>
  );

  // ---- Container ANCHOR row -------------------------------------------------
  //
  // A type declaring `BlockHandle.anchor` renders no line: its content IS its
  // children. Three things follow, none of them optional:
  //
  //  - **No rail of its own.** Its slots would be identical to its first child's,
  //    on the same visual line. That line's rail is the container's — the seat
  //    resolver hands it the container as its owner — so a second one here would
  //    be a duplicate set of controls (and a second dnd-kit draggable under the
  //    same `drag:<id>`) for one visual line. The decoration below is appearance
  //    and its own click surface, nothing structural.
  //  - **Zero height while children are visible**, so the decoration and the
  //    first child share one line. The row is `relative` and nothing in the
  //    chain clips, so the absolutely-positioned column escapes it fine.
  //  - **A one-line box when childless.** `computeFrameSpans` deliberately spans
  //    a childless container over its own row alone, so at zero height the frame
  //    would paint a 0px box over a 0px row: invisible, unclickable,
  //    undeletable. The fallback is a hard requirement, not polish.
  if (handle?.anchor === true) {
    return (
      <div
        ref={setDropRef}
        data-block-id={block.id}
        className="group/row relative"
        style={
          {
            paddingLeft: contentLeft,
            // The same three reserves an ordinary row makes (see the return
            // below). All three are `0px` on an anchor WITH visible children —
            // the resolver hands its frame's opening pad to the first row that
            // renders a line, which is what keeps this row zero-height. They are
            // non-zero for a CHILDLESS container, whose frame opens and closes
            // on this row, over the one-line fallback below.
            paddingRight: framePadX(seat.padFrames),
            paddingTop: framePadY(seat.padFramesOpening),
            paddingBottom: framePadY(seat.padFramesClosing),
            "--gutter-first-line-center": firstLineCenter,
          } as CSSProperties
        }
      >
        <SelectionMarker isSelected={isSelected} />
        {/* The decoration, in the seat its own registration asked for — a glyph
            in the box's indent column, or the card's name in the box's top-right
            corner. Both sit in the ROW layer (`z-raised`), above the frame, which
            is what makes them clickable: the frame is `pointer-events-none` and
            painted under every row it spans. */}
        {decoration?.seat === "corner" ? (
          <div
            // eslint-disable-next-line layout/no-adhoc-layout -- the corner seat is pinned one pad inside the frame box's own corner, from surface-computed CSS lengths (style below); not a ramp-expressible anchor
            className={cn(CORNER_COLUMN, isDragging && "opacity-40")}
            // One pad MORE than the box itself pulls in by, on both axes — the
            // box clears the frames around it, the name clears the box too.
            style={{
              right: framePadX(seat.padFrames),
              top: framePadY(seat.padFrames),
            }}
          >
            <AnchorDecoration
              component={decoration.component}
              block={block}
              editor={api}
            />
          </div>
        ) : (
          /* The glyph column: exactly one BLOCK_INDENT wide, seated at the box's
             own left edge — inside the tint it decorates, and in the gap the
             enclosed rows' rail no longer occupies (they seat theirs at the
             frame's edge). */
          <div
            // eslint-disable-next-line layout/no-adhoc-layout -- the anchor column is positioned from JS coords (style left/width below), so no layout primitive can express it; see ANCHOR_COLUMN
            className={cn(ANCHOR_COLUMN, isDragging && "opacity-40")}
            style={{ left: frameBoxLeft(contentLeft), width: BLOCK_INDENT }}
          >
            {decoration ? (
              <AnchorDecoration
                component={decoration.component}
                block={block}
                editor={api}
              />
            ) : null}
          </div>
        )}
        {/* Childless fallback: one empty body line so the frame has a real box
            to paint, and the container stays selectable and deletable. */}
        {!hasVisibleChildren && <div style={{ minHeight: ONE_EMPTY_LINE }} />}
        {/* On a zero-height row both drop arms land on the same y, and after the
            editor's `rowAtPointer` height guard an anchor can only ever resolve
            to `before` — so render that arm alone. The childless fallback has a
            real box, so it honors the resolved zone. */}
        {dropZone && dropIndicator(hasVisibleChildren ? "before" : dropZone)}
      </div>
    );
  }

  return (
    <div
      ref={setDropRef}
      data-block-id={block.id}
      className="group/row relative"
      style={
        {
          paddingLeft: contentLeft,
          // The card's padding, reserved by the rows because a backdrop cannot
          // make space of its own. RIGHT is one pad per frame enclosing this row
          // — one MORE than each of those frames pulls its own edge in by, and
          // that difference is the gap. TOP/BOTTOM are only for the rows a box
          // actually begins or ends on. All `0px` for an unframed row.
          paddingRight: framePadX(seat.padFrames),
          paddingTop: framePadY(seat.padFramesOpening),
          paddingBottom: framePadY(seat.padFramesClosing),
          "--gutter-first-line-center": firstLineCenter,
        } as CSSProperties
      }
    >
      <SelectionMarker isSelected={isSelected} />
      <BlockRail seat={seat} />
      {/* Shift+click anywhere on the row extends the block selection instead of
          placing a caret. mousedown + preventDefault stops the text selection /
          focus that a click would otherwise start.

          A row paints NO selection highlight of its own: the highlight belongs
          to the RUN of selected lines, not to one row, so it is a sibling
          decoration over the list's grid (`components/selection-bands.tsx`). */}
      <div
        className={cn(isDragging && "opacity-40")}
        onMouseDownCapture={(e) => {
          if (e.shiftKey && selection) {
            e.preventDefault();
            selection.extendTo(block.id);
          }
        }}
        // Cmd+A's second rung for every caret that is not a Lexical editor (see
        // `internal/select-all-ladder.ts`). A Lexical block always consumes the
        // press itself, so it arrives here already prevented. Containment is
        // checked on the DOM: a popover's search box portaled out of this row
        // still bubbles here through React, and is not this block's caret.
        onKeyDown={(e) => {
          if (e.defaultPrevented || !selection || !isSelectAllKey(e)) return;
          if (!(e.target instanceof Node)) return;
          if (!e.currentTarget.contains(e.target)) return;
          if (hasTextLeftToSelect(e.target)) return;
          e.preventDefault();
          selection.selectAll();
        }}
      >
        {/* The caret host is a function of the block TYPE alone and must never
            flip on state: it is an element-type change on an ANCESTOR of the
            block's renderer, so flipping it would remount the block (and any
            Lexical instance below it) mid-interaction. */}
        {editorHoldsCaret ? (
          <BlockCaretHost
            blockId={block.id}
            isFocused={isFocused}
            editor={api}
            // A void block has no text of its own to be named by, so the
            // insert-menu label is its accessible name. Every registered type
            // declares one; only the `unknown` fallback falls through.
            label={handle?.label ?? block.type}
          >
            <Editor.Block.Dispatch
              block={block}
              isFocused={isFocused}
              editor={api}
              ordinal={ordinal}
            />
          </BlockCaretHost>
        ) : (
          <Editor.Block.Dispatch
            block={block}
            isFocused={isFocused}
            editor={api}
            ordinal={ordinal}
          />
        )}
      </div>
      {/* An expanded nested page (this row is its sub-page or link row) whose
          own rows have not landed: its region says so, one indent step in,
          where those rows will render — never an empty expansion, which would
          read as an empty page. A mount anchor is always a line row, so the
          container-anchor branch above never needs this. */}
      {loadingBelow.has(block.id) && (
        <div style={{ paddingLeft: BLOCK_INDENT }}>
          <Loading variant="rows" count={2} />
        </div>
      )}
      {/* …and one whose rows FAILED to load says so there, with Retry — never
          a loading region that never ends. */}
      {belowFailure !== undefined && (
        <div style={{ paddingLeft: BLOCK_INDENT }}>
          <ResourceErrorInline
            variant="inline"
            subject="this page's blocks"
            error={belowFailure.error}
            refetch={belowFailure.refetch}
          />
        </div>
      )}
      {dropZone && dropIndicator(dropZone)}
    </div>
  );
}
