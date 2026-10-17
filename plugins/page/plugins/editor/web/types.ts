import type { IconRef } from "@plugins/ui/plugins/icons/core";
import type { ClassName } from "@plugins/primitives/plugins/css/plugins/ui-kit/core";
import type { ComponentType } from "react";
import type { Hook } from "@plugins/framework/plugins/hook-value/core";
import type { InsetSides } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import type { SurfaceLevel } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { Block, RichText, RowData } from "../core";
import type { CaretContext } from "./internal/caret-geometry";

/**
 * Row data minus the projection-owned `text` key — what a row-writing API
 * accepts. Declared in `core/row-data.ts` (block creation needs it too) and
 * re-exported here, next to the APIs it types.
 */
export type { RowData };

export interface BlockEditorAPI {
  /**
   * Replace this block's non-text `data`. Since the blob is REPLACED, a control
   * changing one field restates the others — spread `rowDataOf(block.data)`, not
   * `block.data`, so the row's `text` projection never rides along.
   */
  update(data: RowData): void;
  /** Toggle this block's expanded/collapsed state (children show/hide). */
  setExpanded(expanded: boolean): void;
  /**
   * Convert this block to another type, replacing its non-text data payload.
   * `opts.expanded` also resets the open/collapsed state in the same PATCH.
   *
   * The block keeps its id, hence its content doc, hence its text: the row's
   * `data.text` projection is carried over untouched (or dropped when the target
   * type is text-less). Seed `data` from the target handle's `emptyRowData()`.
   */
  convertTo(type: string, data: RowData, opts?: { expanded?: boolean }): void;
  /**
   * Insert a new block of the given type immediately after this one and return
   * its id (minted client-side, so the caller can act on it without awaiting the
   * server). Focuses the new block unless `opts.focus === false` — the gutter `+`
   * keeps focus in its block-type filter and hands it to the block on close.
   */
  insertAfter(type: string, data: unknown, opts?: { focus?: boolean }): string;
  /**
   * Split this block at `position`, moving the trailing text into a new block.
   * `asChild` is normally derived internally: when the caret is at the very end
   * of a block that has visible (expanded) children, the new block is nested as
   * the first child instead of inserted as a following sibling. Pass
   * `opts.asChild`/`opts.childType` to force nesting (and the child's type).
   * `opts.runs` carries the editor's authoritative current rich-text so the
   * reducer splits the live content rather than the (possibly stale) stored one.
   * `opts.tailData` is the resolved per-type-transformed `data` for the tail
   * (e.g. a checked to-do splits into an unchecked one), carried onto the op.
   */
  split(
    position: number,
    opts?: {
      asChild?: boolean;
      childType?: string;
      siblingType?: string;
      tailData?: unknown;
      runs?: RichText;
      /**
       * The end of a selected range `[position, deleteTo)` the Enter replaces:
       * deleted from the line in the same step, so the split and the deletion
       * are ONE undo entry. `runs` are the line BEFORE the deletion.
       */
      deleteTo?: number;
    },
  ): void;
  /**
   * Backspace-at-start intent. If this block is indented (its parent is a normal
   * content block, not the page), this de-indents (outdents) it and keeps focus.
   * Otherwise it merges this block's text into the previous sibling and focuses
   * that sibling. No-op for the first block at top level. `opts.runs` carries the
   * editor's authoritative current rich-text so the reducer merges the live
   * content rather than the (possibly stale) stored one.
   */
  merge(opts?: { runs?: RichText }): void;
  /**
   * Delete-at-end intent (Backspace's mirror). Merges the NEXT visible line up
   * into this block — the source is that next line, so its LIVE runs are read
   * from its own handle. By the visible-line duality the merge target resolves
   * back to this block, so the join lands in this editor and the caret does not
   * move. No-op when this is the last visible line. Takes no `runs`: the source
   * is a different block, read here, not the caller's editor.
   */
  mergeNext(): void;
  remove(): void;
  indent(): void;
  outdent(): void;
  /**
   * Move the caret to the nearest focusable block in `dir`, skipping void blocks
   * with no caret. Up/Down preserve the caret's pixel column (`caret.caretX`);
   * Left/Right land at the previous block's end / next block's start. `caret` is
   * omitted by void/textarea blocks (divider, code) that have no Lexical caret —
   * the target then lands at its boundary edge.
   */
  navigate(dir: "up" | "down" | "left" | "right", caret?: CaretContext): void;
  onFocus(): void;
}

/** What an `Editor.InsertAction` runs against: the line the menu was opened on. */
export interface InsertActionContext {
  /** The caret line's block id. The item acts on this line, in place. */
  blockId: string;
  /** The caret line's own block API. */
  editor: BlockEditorAPI;
  /**
   * The line's text with the query removed — what the user had on the line
   * besides the command. Read from the live editor and cut here, because the
   * strip itself lands only after `run` returns (the menu commits inside the
   * editor's own update), so neither the row nor the doc says it yet. An action
   * that replaces the line carries this over (as a title, say) instead of
   * dropping the user's words.
   */
  text: RichText;
}

/**
 * An entry of the insert menus (`/` and the gutter `+`) that RUNS something
 * instead of converting the caret's line into a block type. See
 * `Editor.InsertAction`.
 */
export interface InsertAction {
  /** Unique among insert actions; keys the menu row. */
  id: string;
  /** The menu row's text, and what the `/` query is matched against first. */
  label: string;
  icon: IconRef;
  /** Extra words the `/` query matches, ranked below `label` matches. */
  aliases?: string[];
  /**
   * The block type this entry is listed right after, in whichever section the
   * block menu's config puts that type — so an action sits beside the block it
   * belongs with without the config (which only orders block types) having to
   * know it exists. Absent, or that type not offered: a trailing section of its
   * own.
   */
  after?: string;
  /**
   * A hook returning the runner that acts on the caret's line. A hook, not a
   * plain function, so the runner can read what the editor's HOST provides by
   * context (how a page opens, say) — the editor itself knows none of it. The
   * menu calls it once per editor line, whether or not the menu is open.
   *
   * The menu has already consumed the query text (the `/…` span, or the gutter
   * draft's filter) when the runner runs, exactly as it does before a block-type
   * conversion. Synchronous by contract: a server call is fired from it and owns
   * its own failure (`void promise` surfaces a rejection as an uncaught error),
   * since the menu is gone by the time it settles.
   */
  useRun: Hook<() => InsertActionRun>;
}

/** What an `InsertAction`'s `useRun` returns: act on the caret's line. */
export type InsertActionRun = (ctx: InsertActionContext) => void;

export interface BlockRendererProps {
  block: Block;
  isFocused: boolean;
  editor: BlockEditorAPI;
  /** 1-based position within the consecutive run of same-type siblings; only ordinalMarker blocks use it. */
  ordinal: number;
}

/**
 * Props every block REGION receives. Shaped after `BlockAnchorProps` (NOT
 * `BlockRendererProps`): the read-only surface renders `ReadOnlyNode`s, which are
 * not `Block`s — a snapshot may carry no id and never carries a `pageId`. Flat
 * fields let ONE contribution render on both surfaces.
 *
 * There is deliberately no `children`: a region is a SIBLING of the editable
 * line and structurally cannot wrap it. That is the invariant, expressed as a
 * type — see `TextBlockLayout`.
 *
 * `editor` is absent on read-only surfaces (version-history preview, the public
 * site) — degrade to a static rendering, never a control whose click no-ops.
 */
export interface BlockRegionProps {
  id: string;
  type: string;
  /** Owning page; `null` on a read-only surface rendering a detached snapshot. */
  pageId: string | null;
  /**
   * RAW row blob, possibly partial/historical (and transient mid-edit) — read it
   * through your own handle's `safeParse`, with a default, never `parse`. Same
   * rule `CalloutAnchor` / `CalloutFrame` follow on the container axis.
   */
  data: unknown;
  isFocused: boolean;
  /** 1-based position among the consecutive run of same-type siblings. */
  ordinal: number;
  editor?: BlockEditorAPI;
}

export type BlockRegion = ComponentType<BlockRegionProps>;

/**
 * The four sibling positions around the editable line. **Closed by geometry**: a
 * leaf inside a box has exactly two positions on the block axis and two on the
 * inline axis, so a new block type never needs a new one. All four always render
 * (as `null` when undeclared); `header` and `end` have no consumer today, which
 * is the price of closing the set rather than merely claiming it is closed.
 */
export interface BlockRegions {
  /** Block-before: a full-box-width row above the line. */
  header?: BlockRegion;
  /** Inline-before: the leading `MARKER_GUTTER` column. Overrides the handle's marker ladder. */
  start?: BlockRegion;
  /** Inline-after: a rigid cell trailing the text column. */
  end?: BlockRegion;
  /** Block-after: a full-box-width row below the line. */
  footer?: BlockRegion;
}

/**
 * A text-bearing block type's presentation: how the shared skeleton's elements
 * are STYLED, plus the sibling regions it contributes around the editable line.
 * It can never wrap the line — a region receives no `children` — which is what
 * keeps a type change a re-style instead of a remount. See `TextBlockLayout`.
 *
 * `chrome` is a STATIC object, built once at module eval inside the contribution
 * literal, so a region component's identity is a module constant BY
 * CONSTRUCTION. A `chrome(data)` function would be a place where a fresh
 * component can be minted (resetting that region on every keystroke) and a place
 * where a hook can be called from inside a per-type conditional (crashing on
 * conversion). Neither is representable here. The one data-dependent knob,
 * `boxClassName`, returns a **string**: it cannot mint a component, and
 * `rules-of-hooks` rejects a hook inside a plain lowercase function.
 */
export interface BlockChrome {
  /**
   * Padding OUTSIDE the box — decoration edge `C` → box. Static, and vertical
   * padding must not vary per row: `BlockHandle.gutterFirstLineCenter` is a
   * static per-type declaration, so a row-dependent `y` would seat the gutter
   * rail on a phantom line.
   */
  padding?: InsetSides;
  /** Semantic elevation, composed as `SURFACE_LEVELS[level]` on the box. */
  surface?: SurfaceLevel;
  /**
   * Everything else painted on the box. **PAINT ONLY** — no padding (see
   * `padding` above) and no `overflow`: Lexical's scroll-into-view and
   * `internal/caret-geometry.ts` resolve against the nearest scrollable
   * ancestor, so a stray `overflow-*` would silently change caret scroll
   * semantics.
   */
  boxClassName?: ClassName | ((data: unknown) => ClassName);
  /** Whether the LINE supplies the page column's left inset (default true). */
  inset?: boolean;
  regions?: BlockRegions;
}

/**
 * Props for a CONTAINER FRAME — the decorated box a container block type paints
 * over itself AND its whole visible subtree (the callout's tint, and any future
 * bordered container).
 *
 * A block renderer (`BlockRendererProps`) can only ever paint its OWN row: the
 * editable surface renders the forest as a flat list of sibling rows so a
 * structural move only reorders keyed elements (see `block-editor.tsx`'s
 * `flattenTree`), which means a block's children are not its DOM children. A
 * frame contribution is the seam for the other half.
 *
 * ## A frame is a BACKDROP, never a wrapper
 *
 * It renders a standalone box and receives **no children**. Each surface sizes
 * and positions it over the container's rows in whatever way suits that surface
 * (the editor spans CSS grid lines; the read-only renderer paints an
 * `absolute inset-0` layer behind its nested subtree). That contract is
 * load-bearing, not stylistic: a frame that WRAPPED the rows would change their
 * DOM parent whenever a block is indented across its boundary, remounting that
 * block's Lexical instance and dropping the caret — measured, see
 * `internal/block-frames.ts`.
 *
 * Consequences a frame must respect:
 *
 * - It is **inert**: the surface renders it `pointer-events-none`, behind the
 *   rows — frames are emitted BEFORE the rows they span (equal stacking level →
 *   document order decides), so anything interactive placed in that layer is
 *   hit-tested *under* the following row and can never be clicked. It cannot
 *   host controls. The sanctioned interactive companion is the **anchor**
 *   (`BlockAnchorProps`), which the surface renders in the row layer.
 * - It is given a **positioned box** to paint into and has no content of its
 *   own, so it fills that box with `absolute` insets. Do NOT use `h-full`: an
 *   explicit height defeats the editor's grid stretch, and any vertical bleed
 *   then shifts the box instead of growing it.
 * - It must add no horizontal offset of its own: the box it paints is the one
 *   the SURFACE measured, handed over whole. Rows seat their hover controls
 *   against a content edge the surface computed (this frame's, for the rows
 *   inside it), so shifting the flow would strand them — and the rows inside
 *   reserve their `padding-right` from the same count this box's right edge
 *   comes from, so a second opinion here would put a card's text past its own
 *   tint. Consumers hand these props straight to `ContainerBackdrop` and supply
 *   appearance classes only.
 */
export interface BlockFrameProps {
  /** The container block's type — the dispatch key. */
  type: string;
  /** The container block's `data`; the frame reads its own appearance off it. */
  data: unknown;
  /**
   * The container block's row id, for a frame whose appearance depends on
   * something stored BESIDE the row — a side table keyed by block id, say the
   * status of a task the card is linked to — rather than on `data`. Same reason
   * `BlockAnchorProps` carries one: a frame is dispatched by `type`/`data`
   * alone, so without an id it can only ever paint what `data` says.
   *
   * OPTIONAL, and it degrades exactly like the anchor's does: the read-only
   * surface renders `ReadOnlyNode`s, which may legitimately carry no id at all
   * (see `read-only-view`'s renderer), so a frame that needs one must fall back
   * to its static appearance rather than assume the editable surface.
   */
  blockId?: string;
  /**
   * Distance (px) from the frame box's left edge to the container block's
   * content edge `C` — the ORIGIN the box is measured from, not the box's own
   * edge. Zero on surfaces with no rail (the read-only renderer).
   *
   * The painted left edge is `frameBoxLeft(inset)`, one `BLOCK_INSET` further
   * in, which is where every other decorated block already paints; the frame
   * does not apply that itself (`ContainerBackdrop` does, once, for all of
   * them). See `internal/page-column.ts`.
   */
  inset: number;
  /**
   * How far the box's RIGHT edge pulls in from the surface's own right edge, as
   * a CSS length — one `FRAME_PAD_X` per frame enclosing this one, its own
   * EXCLUDED. The rows inside reserve one pad MORE than this (their own frame
   * counts for them), and that difference of exactly one is the card's right
   * padding: text stops one pad inside its own tint, and a nested card closes
   * one pad inside its parent.
   */
  rightInset: string;
  /**
   * How far the box's TOP and BOTTOM edges pull in from the row range the
   * surface gave it, as CSS lengths — the same count as `rightInset`, on the
   * other axis, so a nested card starts one pad below its parent instead of on
   * the same y (every container anchor is zero-height, so without this every
   * box in a nest would share one top edge).
   *
   * The pad itself is made by the ROWS, not here: a backdrop that grew upward
   * would overlap the block above rather than displace it, so the first row a
   * padded frame covers reserves `padding-top` and the last reserves
   * `padding-bottom`. This is only the nesting share of it.
   */
  topInset: string;
  bottomInset: string;
}

/**
 * Props for a container ANCHOR's decoration — the leading glyph of a block type
 * that declares `BlockHandle.anchor` (the callout's icon). An anchor renders no
 * line of its own: its content IS its children, so the row itself collapses to
 * zero height and this component is the only thing it paints.
 *
 * ## The SURFACE owns the geometry; this renders appearance + interaction
 *
 * The surface positions this component in a `BLOCK_INDENT`-wide column at the
 * container's content edge `C`, vertically centred on the FIRST VISIBLE CHILD's
 * first line (borrowed, because the anchor has no line of its own to measure —
 * see `BlockHandle.gutterFirstLineCenter`). A contribution therefore:
 *
 * - **must not position itself** — `BLOCK_GUTTER` is deliberately not exported
 *   from the web barrel and `BlockRendererProps` carries no `depth`, precisely so
 *   no block contribution can compute the content edge;
 * - **must not establish flow height** — the column is `absolute`, and the row's
 *   zero height is what lets the anchor and its first child share one visual
 *   line. Anything that grows the row pushes the whole container apart.
 *
 * Unlike a frame this IS interactive: it sits in the row layer, above the frame,
 * so it can carry the container's own APPEARANCE affordance (the callout's
 * icon/colour picker). That is the whole reason the frame stays inert — see
 * `BlockFrameProps`.
 *
 * ## Appearance only — the structure lives on the rail
 *
 * The anchor used to carry the container's whole block-actions menu, because an
 * anchor row paints no rail of its own and there was nowhere else to hang one.
 * There is now: the rail on the line the container BORROWS resolves the
 * container as its owner (`internal/rail-seat.ts`), so `+`, drag, and the
 * actions menu all act on the container and the menu's container arm carries
 * Collapse / Remove / Delete. Hence the props this interface no longer needs —
 * no `id` (nothing here is addressed by one), no `expanded`/`foldable` (nothing
 * here folds).
 *
 * A container's per-instance appearance is reachable from BOTH surfaces, by
 * design: it renders here AND as a `BlockFrameMeta.menu` contribution in that
 * rail popover. The rail is where a user looks for block actions; the glyph is
 * where they look for the glyph.
 *
 * `editor` is absent on read-only surfaces (the blog renderer, the
 * version-history preview), which have no block API at all. Degrade to a static
 * glyph rather than rendering a dead control.
 */
export interface BlockAnchorProps {
  /** The container block's type — the dispatch key. */
  type: string;
  /** The container block's `data`; the anchor reads its own appearance off it. */
  data: unknown;
  /**
   * The container block's row id, for an anchor whose appearance depends on
   * something stored BESIDE the row — a side table keyed by block id, say
   * provenance — rather than on `data`.
   *
   * OPTIONAL, and it degrades exactly like `editor` does: the read-only surface
   * renders `ReadOnlyNode`s, which may legitimately carry no id at all (see
   * `read-only-view`'s renderer), so an anchor that needs one must fall back to
   * the static glyph rather than assume the editable surface.
   */
  blockId?: string;
  /** The block API, on editable surfaces only. Absent ⇒ render a static glyph. */
  editor?: BlockEditorAPI;
}

/**
 * Props for a container's FOOT — a full-box-width strip of the container's own
 * chrome at the BOTTOM of the box it paints: below its last visible child,
 * inside the card's padding, aligned under the card's text rather than with the
 * box's edge. A TODO card's chips for the runs it has launched are the one
 * today. A container declares one with `BlockFrameMeta.foot`; the editor never
 * learns what is in it.
 *
 * ## Why a foot is not a decoration
 *
 * A container's two decoration SEATS (`BlockAnchorProps`) both float over the
 * content and reserve no space — a glyph in the indent column, a name in the
 * corner. A foot is the opposite: it is chrome the box MAKES ROOM FOR. Its
 * height is its own, so a chip row that wraps to two lines grows the card
 * instead of overlapping its last line, and the card's bottom pad moves below
 * it (`internal/frame-foot.ts`). That is why it is a field of its own rather
 * than a third arm of `BlockFrameDecoration`.
 *
 * ## The SURFACE owns the geometry; this renders content
 *
 * The surface pads the strip on all four sides — the card's own left content
 * edge, its right and bottom pads, and one pad of gap above — and places it in
 * the ROW layer, after the frame in DOM order, so unlike the frame it CAN carry
 * controls (the frame is `pointer-events-none` and hit-tested under the rows).
 * A contribution therefore positions nothing and adds no padding of its own; it
 * fills the width it is given and is as tall as its content.
 *
 * Both optionals degrade exactly as an anchor's do. `blockId` is absent wherever
 * the surface renders a detached snapshot (`read-only-view`'s nodes may carry no
 * id at all), and `editor` is absent on every read-only surface. A foot whose
 * content is LIVE STATE — the runs a card launched, not something the document
 * says — must render `null` there rather than dressing today's state up as the
 * snapshot's: a version-history preview of last Tuesday showing this morning's
 * runs is a lie the surface cannot detect. Same rule `PromptFooter` already
 * states for its `chrome.regions.footer`.
 */
export interface BlockFootProps {
  /** The container block's type — the dispatch key. */
  type: string;
  /** The container block's `data`; the foot reads whatever it needs off it. */
  data: unknown;
  /**
   * The container block's row id, for a foot whose content is keyed by it — a
   * side table of the runs this card dispatched, say. OPTIONAL: a read-only
   * surface may render a node with no id, and a foot that needs one renders
   * nothing there.
   */
  blockId?: string;
  /** The block API, on editable surfaces only. Absent ⇒ read-only. */
  editor?: BlockEditorAPI;
}
