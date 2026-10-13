import { useState } from "react";
import type { DataViewPagePlaceholders, DataViewSection } from "../../core";

/**
 * One line of a grid band: its cells in column order, `null` for a phase-pad
 * spacer, keyed by its ABSOLUTE line (`line:<n>@<columns>`) — the same line of
 * the read keeps its key when the pages above it are released or land, so a
 * windowed line stays mounted across both.
 */
export interface GridLine<T> {
  key: string;
  cells: readonly (T | null)[];
}

/**
 * Where a grid band's cells sit in its read, so a release or a landing above
 * them never moves one to another column — the gallery's and icons' phase pad.
 */
export interface GridPhase {
  /**
   * The band's read pages (it draws placeholders): the view measures its
   * column count in both its branches, so the pad is right in the render a
   * release happens in.
   */
  paged: boolean;
  /** Spacer cells ahead of the first drawn cell at `columns` (0 until measured). */
  pad: (columns: number) => number;
  /** `cells` cut into lines of `columns`, the pad's spacers first. */
  lines: <T>(cells: readonly T[], columns: number) => GridLine<T>[];
}

interface PhaseState {
  keys: readonly string[];
  releasedAbove: boolean;
  base: number;
  index: ReadonlyMap<string, number>;
}

/**
 * The phase of one grid band of `section` (its drawn cells' `keys`, in
 * order): the absolute cell index its first drawn cell sits at.
 *
 * The view records its own layout — each drawn key's absolute cell index —
 * and reads the next render's from it: while pages of the read stand above
 * the band as placeholders (`placeholders.before`, the flat read's for the
 * implicit section, else the declared section's own), the first drawn key
 * whose index is known places the band (`index - its position`); with none
 * above, the band starts at the read's head, index 0. The pad is that index
 * modulo the column count, so a page released mid-line leaves the next card in
 * the column it was drawn in, under a placeholder exactly as tall as the
 * lines the page took. It counts DRAWN cells, so it holds under folding,
 * aggregation and client filtering, where read rows are not cards; a key
 * never drawn before (a jump) restarts at column 0. A live insert at the
 * read's head still reflows the cards after it — a true reflow.
 */
export function useGridPhase(
  section: DataViewSection<unknown>,
  flatPlaceholders: DataViewPagePlaceholders | undefined,
  keys: readonly string[],
): GridPhase {
  const placeholders =
    section.paging?.placeholders ??
    (section.key === null ? flatPlaceholders : undefined);
  const releasedAbove = (placeholders?.before.length ?? 0) > 0;
  const [state, setState] = useState<PhaseState>(() => ({
    keys,
    releasedAbove,
    base: 0,
    index: indexKeys(keys, 0),
  }));
  let base = state.base;
  // Keyed on content, not identity: a render-phase update re-renders at once,
  // so keys re-minted each render would loop forever.
  if (
    state.releasedAbove !== releasedAbove ||
    (state.keys !== keys && !sameKeys(state.keys, keys))
  ) {
    base = releasedAbove ? phaseBase(state.index, keys) : 0;
    setState({ keys, releasedAbove, base, index: indexKeys(keys, base) });
  }
  return {
    paged: placeholders !== undefined,
    pad: (columns) => gridPad(base, columns),
    lines: (cells, columns) => gridLines(cells, columns, base),
  };
}

/**
 * The absolute index of the band's first drawn cell, from the previous
 * layout `index`: the first key it knows, less its position. 0 when it knows
 * none.
 */
export function phaseBase(
  index: ReadonlyMap<string, number>,
  keys: readonly string[],
): number {
  for (let j = 0; j < keys.length; j++) {
    const at = index.get(keys[j]!);
    if (at !== undefined) return at - j;
  }
  return 0;
}

/** Spacer cells ahead of a band starting at absolute cell `base`. */
export function gridPad(base: number, columns: number): number {
  if (columns <= 0) return 0;
  return ((base % columns) + columns) % columns;
}

/** `cells` cut into lines of `columns` from absolute cell `base`, keyed by absolute line. */
export function gridLines<T>(
  cells: readonly T[],
  columns: number,
  base: number,
): GridLine<T>[] {
  if (columns <= 0) return [];
  const pad = gridPad(base, columns);
  const padded: (T | null)[] = [...Array<null>(pad).fill(null), ...cells];
  const first = (base - pad) / columns;
  const out: GridLine<T>[] = [];
  for (let i = 0; i < padded.length; i += columns) {
    out.push({
      key: `line:${first + i / columns}@${columns}`,
      cells: padded.slice(i, i + columns),
    });
  }
  return out;
}

function indexKeys(keys: readonly string[], base: number): Map<string, number> {
  return new Map(keys.map((k, i) => [k, base + i]));
}

function sameKeys(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((k, i) => k === b[i]);
}
