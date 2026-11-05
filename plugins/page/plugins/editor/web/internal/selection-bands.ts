import type { FlatBlock, FrameSpan } from "./block-frames";
import { blockContentLeft } from "./page-column";

/**
 * One painted rectangle of the block-selection highlight, as INDICES into the
 * flat list (`start`/`end` inclusive) plus the decoration edge it starts at.
 *
 * ## Why a band and not a class on each row
 *
 * A selection of N consecutive blocks is ONE region of the page, and the user
 * reads it as one. Painting it per row — the shape this replaced — restates it
 * as N boxes: every internal boundary gets two rounded corners and two hairlines
 * meeting, so a three-paragraph selection reads as three stacked cards rather
 * than one highlighted passage. No amount of colour tuning fixes that; the
 * seams are structural.
 *
 * So the highlight is resolved the same way a container's frame is
 * (`block-frames.ts`): a SIBLING decoration spanning grid lines `start..end`
 * over the rows' own single-column grid. The run has no internal edges to draw,
 * because it is one element. Three things follow for free:
 *
 *  - **Consecutive rows can never show a gap** — a grid item spanning the lines
 *    covers each row's full cell, whatever padding the block types inside carry.
 *  - **Rounding belongs to the RUN, not the row**, so only the first and last
 *    line of a selection are rounded.
 *  - **A container needs no special case.** A selected container paints over its
 *    whole frame span, which is what "select the callout" means — and an ANCHOR
 *    container (a zero-height row) is covered by the same rule rather than by a
 *    second copy of the highlight keyed on `handle.anchor`.
 *
 * The band starts at the decoration edge `C` (`page-column.ts`'s invariant lists
 * the selection highlight among the decorations that do) and runs to the content
 * box's right edge — the same box `ContainerBackdrop` paints into, so a selected
 * callout's tint and its selection band are concentric.
 *
 * ## A line wider than the column
 *
 * A row whose content grows PAST the column (a `WideBlock` table, centered on
 * it) reports how far it overhangs it — its {@link RowOverhang}, measured by
 * the box itself (`components/row-overhang.tsx`). Such a line's band grows by
 * exactly that much on each side, so it keeps the same margin around the
 * widened table it keeps around any content, instead of cutting through the
 * table's middle. A box within the column overhangs nothing and changes
 * nothing.
 */
export interface SelectionBand {
  /** Stable across renders for a given run start — the React key. */
  key: string;
  /** First flat-row index this band covers. */
  start: number;
  /** Last flat-row index this band covers (inclusive). */
  end: number;
  /** px from the row grid's left edge to the band's left edge (`C`, or further
   * left where a wide line overhangs it). */
  left: number;
  /** px from the row's right edge in to the band's right edge: `0` for the
   * column, negative where a wide line overhangs it. */
  right: number;
  /** This band opens a run (nothing selected on the line above). */
  roundTop: boolean;
  /** This band closes a run (nothing selected on the line below). */
  roundBottom: boolean;
}

/**
 * How far (px, ≥ 0) a row's content paints past its column on each side — a
 * box wider than the column it is centered on.
 */
export interface RowOverhang {
  left: number;
  right: number;
}

/** A band's two horizontal edges, in its row cell: see {@link SelectionBand}. */
interface BandEdges {
  left: number;
  right: number;
}

/**
 * Resolve the selection into painted bands.
 *
 * A run is split into several bands wherever an edge STEPS — a selected block
 * one level deeper than the line above it starts further right; a wide line
 * reaches further out on both sides than the paragraph above it — and those
 * bands touch, so the step is a visible notch in one continuous region rather
 * than two detached boxes. Only the run's outer ends are rounded.
 *
 * Selected blocks with no visible row (hidden under a collapsed ancestor) paint
 * nothing: there is no line on screen to highlight. That is the same reason the
 * frame spans are derived from the flatten rather than from the forest.
 */
export function resolveSelectionBands(
  flat: readonly FlatBlock[],
  frameSpans: readonly FrameSpan[],
  selectedIds: ReadonlySet<string>,
  /** Per block id, how far a line wider than its column overhangs it. */
  overhangs: ReadonlyMap<string, RowOverhang>,
): SelectionBand[] {
  if (selectedIds.size === 0 || flat.length === 0) return [];

  const spanOf = new Map<string, FrameSpan>();
  for (const span of frameSpans) spanOf.set(span.block.id, span);

  // Per visible line: the decoration edge the selection paints it at, or null.
  // Nested selections (a selected block inside a selected container) collapse
  // onto the OUTERMOST edge — one region, painted once, at the box that
  // encloses it.
  const edge: (number | null)[] = new Array<number | null>(flat.length).fill(
    null,
  );
  /** In-range read. The array is exactly `flat.length` long, so this is total. */
  const edgeAt = (index: number): number | null => edge[index] ?? null;
  const paintLine = (index: number, left: number) => {
    const current = edgeAt(index);
    edge[index] = current === null ? left : Math.min(current, left);
  };

  for (let i = 0; i < flat.length; i += 1) {
    const entry = flat[i]!;
    if (!selectedIds.has(entry.block.id)) continue;
    const span = spanOf.get(entry.block.id);
    if (span) {
      const left = blockContentLeft(span.depth);
      for (let line = span.start; line <= span.end; line += 1)
        paintLine(line, left);
    } else {
      paintLine(i, blockContentLeft(entry.depth));
    }
  }

  // Per painted line: its band's two edges — the decoration edge and the
  // row's right edge, pushed out by what a wide line overhangs its column.
  const edgesAt = (index: number): BandEdges | null => {
    const left = edgeAt(index);
    if (left === null) return null;
    const over = overhangs.get(flat[index]!.block.id);
    return {
      left: left - Math.max(0, over?.left ?? 0),
      right: 0 - Math.max(0, over?.right ?? 0),
    };
  };
  const sameEdges = (a: BandEdges | null, b: BandEdges | null) =>
    a !== null && b !== null && a.left === b.left && a.right === b.right;

  const bands: SelectionBand[] = [];
  let i = 0;
  while (i < flat.length) {
    if (edgeAt(i) === null) {
      i += 1;
      continue;
    }
    let runEnd = i;
    while (runEnd + 1 < flat.length && edgeAt(runEnd + 1) !== null) runEnd += 1;

    let segStart = i;
    for (let line = i; line <= runEnd; line += 1) {
      const edges = edgesAt(line)!;
      if (line < runEnd && sameEdges(edges, edgesAt(line + 1))) continue;
      bands.push({
        key: `selection:${segStart}`,
        start: segStart,
        end: line,
        left: edges.left,
        right: edges.right,
        roundTop: segStart === i,
        roundBottom: line === runEnd,
      });
      segStart = line + 1;
    }
    i = runEnd + 1;
  }
  return bands;
}
