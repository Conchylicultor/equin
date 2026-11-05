import {
  spaceLength,
  type SpaceStep,
} from "@plugins/primitives/plugins/css/plugins/space-ramp/core";

/**
 * The single declaration site for the page column's horizontal geometry.
 *
 * The invariant — a page's **block content box** has a left edge `C`:
 * - `C` is the **origin** the surface computes and the rail seats against; it is
 *   where a block's box is *measured from*, not where paint lands.
 * - Block **content** (text, media) insets from `C` by `BLOCK_INSET`.
 * - Block **decorations paint that same content box**, so a box's own edge and
 *   the first letter of the prose above it share one x. A code block's
 *   background, a place block's card and a container's frame all sit at
 *   `[C + BLOCK_INSET, R]` — see `frameBoxLeft`, which is how the container
 *   family says it. How far the CONTENT of such a box then stays off its edges
 *   is a separate question, and a separate declaration: `FRAME_PAD_X` /
 *   `FRAME_PAD_Y` at the foot of this file. Alignment places the edge; it has no
 *   opinion about padding, and for a while nothing else did either.
 * - Anything a host renders *alongside* blocks that is not itself a block — the
 *   page title, the page icon, the section list — sits at `C + BLOCK_INSET`.
 *
 * This used to read "block decorations start at `C`", and the container frame
 * was the only thing that believed it: an ordinary decorated block (code, place)
 * paints inside its own `<Inset x={BLOCK_INSET}>` content box and always did.
 * So a callout's tint stood `BLOCK_INSET` to the LEFT of every paragraph on the
 * page, and of every other decorated box. Measured, then fixed — the container
 * frame now paints what everything else paints.
 *
 * The editable surface puts the hover rail (`BLOCK_GUTTER`) to the *left* of
 * `C`, inside each row's own padding — that placement is editable-surface-only
 * (the read-only renderer has no rail, so `C` is simply its left edge). Each row
 * reserves the rail as its OWN padding-left (not the list container's) so the
 * rail is inside the row's box: the hover controls (+ / drag / chevron) sit at
 * -60/-40/-20 from the content edge of its **outermost enclosing container
 * frame** — which for an unframed row is its own — and the pointer entering the
 * rail from anywhere, including from the far left or across the gap left by an
 * absent chevron, hovers the row and reveals them. Reserving the rail on the
 * container instead would put it outside every row, and since the controls are
 * `pointer-events-none` while hidden, nothing under the pointer could ever
 * reveal them. `BLOCK_GUTTER` must stay wider than the leftmost button's offset.
 *
 * The outermost-frame rule (rather than the simpler "its own content edge") is
 * forced by container ANCHORS: an anchor's decoration column occupies
 * `[C, C+BLOCK_INDENT]`, which is exactly where its first child's chevron would
 * sit if that child seated its rail against its own edge — and the child's row
 * comes later in DOM order at the same `z-raised` level, so the decoration would
 * not merely be overlapped, it would be unclickable. Seating a framed row's rail
 * against the frame's edge puts the controls OUTSIDE the box, leaving the
 * decoration column free. `BlockRow` takes the resolved seat as a prop; the
 * editor derives it from the frame spans it already computes, so rows still
 * compute no geometry of their own.
 *
 * That SPAN rule is geometry and nothing else — it says where the controls sit,
 * never what they act on. WHICH block a row's rail targets is a separate
 * BORROW-CHAIN rule, because only a container's borrowed first LINE hands its
 * rail over while lines 2..n inside the same frame keep their own. Both live on
 * `RailSeat` (`internal/rail-seat.ts`); conflating them is what let the drag
 * handle on a callout's first line pull that line out of the box.
 *
 * Hosts must never re-derive the content edge from `BLOCK_GUTTER` plus whatever
 * padding their wrapper happens to carry — they align onto it via
 * `PageContentColumn` / `BLOCK_INSET`, and `BLOCK_GUTTER` is editor-internal.
 */

/** Rail width (px): hover controls hang into it at -20/-40/-60 from the content edge. */
export const BLOCK_GUTTER = 64;

/** Per-depth indent (px) of a nested block's content box. */
export const BLOCK_INDENT = 24;

/** Decoration-edge → content-edge inset. Every block's content sits here. */
export const BLOCK_INSET: SpaceStep = "md";

/** Fixed leading-marker column (bullet / number / checkbox / callout icon). */
export const MARKER_GUTTER = "1.5rem";

/**
 * The content edge `C` of a block at `depth`, in px from the row's own left
 * border edge (which is where the rail starts). The single derivation of the
 * rail + per-depth indent sum — a container frame insets its decoration to it so
 * the box starts at the content edge instead of bleeding over the rail, and it
 * is what `resolveRailSeats` evaluates (at the row's own depth, or at its
 * outermost enclosing frame's) to hand each row its seat's `left`.
 *
 * `absorbed` is how many enclosing container frames have ABSORBED this row's
 * indent step and replaced it with their own padding — see `FRAME_PAD_X`. Each
 * one pulls the edge back by the difference, so the card's content sits one
 * `FRAME_PAD_X` inside its box rather than one `BLOCK_INDENT`. Zero for every
 * row not inside such a frame, which is why it defaults: a caller with no frames
 * in view is asking the same question it always asked.
 */
export function blockContentLeft(depth: number, absorbed = 0): number {
  return (
    BLOCK_GUTTER +
    depth * BLOCK_INDENT -
    absorbed * (BLOCK_INDENT - FRAME_PAD_X)
  );
}

/**
 * The left edge of the box a container frame paints, as a CSS length: its own
 * content edge `C`, plus the same `BLOCK_INSET` every other decorated block
 * already insets its box by. This is what puts a card's border on the same x as
 * the first letter of the paragraph above it.
 *
 * A `calc()` over `var(--space-md)` rather than a resolved px number, so the box
 * follows the density preset exactly as the content it wraps does — resolving
 * the token in JS would freeze it at whatever the ramp said on first render.
 *
 * The frame's DECORATION COLUMN (the callout's icon) reads this too: the glyph
 * seats inside the box it decorates, so the two cannot drift.
 */
export function frameBoxLeft(contentEdge: number): string {
  return `calc(${contentEdge}px + ${spaceLength(BLOCK_INSET)})`;
}

/**
 * The card's inner PADDING — the gap between the box a container frame paints
 * and the text inside it. Declared here, once, on both axes, and read by every
 * side of every box: the four sides can no longer disagree because there is
 * nothing for them to disagree about.
 *
 * It was introduced because they did. The box's edges and its content's edges
 * used to be computed independently, from quantities chosen for ALIGNMENT, and
 * whatever fell out between them became the padding by accident: measured on a
 * real page, a card had 24px on the left, **0 on the right, and 0 top and
 * bottom** — text landing exactly on its own tint, which reads as a clipping
 * bug. Alignment says where the box's EDGE goes; it has no opinion about how far
 * the content must stay off it, and nothing else had one either.
 *
 * ## The left side had to be BOUGHT before this could be a free number
 *
 * A card's contents are its CHILDREN, one indent level deeper, and its box
 * starts on the prose x — so the left gap is `BLOCK_INDENT` and the frame cannot
 * shrink it by declaring anything. The first version of this constant conceded
 * that and pinned itself to `BLOCK_INDENT`, making the other three sides agree
 * with the one side that was already decided. It measured 24px against the
 * design's 16, and read as visibly heavier than the mock it came from.
 *
 * So the frame ABSORBS that indent step and spends it as padding instead:
 * `blockContentLeft` pulls a framed row's content edge back by
 * `BLOCK_INDENT - FRAME_PAD_X` per absorbing frame. The box's own edge does not
 * move (it is still the prose x), nesting still opens one pad per level, and the
 * number is finally free.
 *
 * **A frame may only absorb a column nothing is standing in.** A container whose
 * decoration is a GUTTER GLYPH (the callout's icon) puts that glyph in exactly
 * this column, sized to `BLOCK_INDENT`; reclaiming it would crop the icon. So
 * absorption is gated on the decoration SEAT — corner-seat containers (the
 * annotation cards) absorb, gutter-seat ones keep the column their glyph
 * occupies. Derived from the seat rather than declared a second time, so a
 * container cannot claim a column it also draws in.
 *
 * ## Why Y is smaller than X
 *
 * A horizontal gap is measured to a GLYPH; a vertical one to a LINE BOX, which
 * already carries the row's own `py-xs` at each end plus half the line's
 * leading. Equal numbers would not read as equal — the effective vertical gap is
 * `FRAME_PAD_Y` plus all of that. A token rather than px, so the vertical rhythm
 * follows the density preset exactly as the lines it separates do.
 */
export const FRAME_PAD_X = 16;

/** The vertical half of {@link FRAME_PAD_X}. See there for why they differ. */
export const FRAME_PAD_Y: SpaceStep = "sm";

/**
 * `frames` pads' worth of horizontal space, as a CSS length.
 *
 * ONE function for every horizontal gap around a card, called with a COUNT, so
 * the arithmetic exists once and a call site's only job is to say how many boxes
 * it is clearing. Two counts are in play and they differ by exactly one, which
 * is the padding:
 *
 * - a **row** passes the frames ENCLOSING it (its own included when it is a
 *   padded container's anchor) and reserves that as `padding-right`;
 * - a **frame** passes the frames enclosing it with **its own excluded**, and
 *   pulls its box's right edge in by that.
 *
 * So the innermost box ends one pad outside the text it wraps, and each box
 * further out ends one pad outside the box it wraps — the same ladder the left
 * edge already climbs by `BLOCK_INDENT`.
 *
 * This used to be one count for both, which is exactly how the right gap became
 * zero: the reserve equalled the pull, and the two edges landed on the same x.
 */
export function framePadX(frames: number): string {
  return frames <= 0 ? "0px" : `${frames * FRAME_PAD_X}px`;
}

/**
 * `frames` pads' worth of vertical space, as a CSS length — the vertical twin of
 * {@link framePadX}, read with the same two counts.
 *
 * A backdrop cannot buy vertical space (it would overlap the next block rather
 * than displace it), so the space is made by the ROWS: the first row a padded
 * frame covers reserves `padding-top`, the last reserves `padding-bottom`, one
 * pad per frame opening or closing there. The frame then pulls its own top and
 * bottom edges in by the pads belonging to the frames AROUND it, which is what
 * makes a nested card start one pad below its parent instead of on the same y.
 */
export function framePadY(frames: number): string {
  return frames <= 0 ? "0px" : `calc(${frames} * ${spaceLength(FRAME_PAD_Y)})`;
}

/**
 * The CSS variable the editor's full-width interaction surface publishes on
 * itself: its own width, in px. Inherited by every block, it is the one length
 * a block cannot otherwise know — how much room the pane has BEYOND the reading
 * column — and what lets a {@link WideBlock} grow past the column into it.
 *
 * Measured rather than read from a container query: `container-type` on the
 * surface would make it a fixed-position containing block for the overlays the
 * editor hosts (the format toolbar, the caret chip), which the viewport-escape
 * auditor reports. Unset on a surface that does not publish it (the read-only
 * renderer), where a wide block simply stays in its column.
 */
export const SURFACE_WIDTH_VAR = "--block-surface-width";

/**
 * The widest a wide block may grow: the surface, less one `BLOCK_GUTTER` on
 * each side — the same margin the rail keeps on the left, mirrored, so a wide
 * table stands off the pane's edges as far as the column's own rows do.
 */
export const WIDE_BLOCK_MAX = `calc(var(${SURFACE_WIDTH_VAR}, 100%) - ${2 * BLOCK_GUTTER}px)`;
