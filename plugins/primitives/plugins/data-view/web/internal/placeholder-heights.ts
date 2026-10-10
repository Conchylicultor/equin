import { useState } from "react";
import type { DataViewPagePlaceholder } from "../../core";

/**
 * One paged read as the body lays it out: its entries in order (the
 * placeholders before its rows, its rows, the placeholders after them) and
 * the placeholders among them. `id` names the read across renders (the
 * flat read, or a declared section by its key).
 */
export interface PagedReadLayout {
  id: string;
  keys: readonly string[];
  placeholders: readonly DataViewPagePlaceholder[];
}

/** A placeholder's height, and the rows it stood for when it was sized. */
interface Sized {
  px: number;
  rows: number;
}

/** A list row's height (`ListView`'s single-line estimate), for rows never measured. */
const DEFAULT_ROW_PITCH = 32;

/**
 * The height each placeholder of `reads` is drawn at, in px: EXACTLY the room
 * its rows took when they were released, so a page turning into a placeholder
 * changes no layout — nothing above the reader moves, and nothing has to be
 * anchored.
 *
 * A placeholder is sized once, in the render it first appears in, and keeps
 * that height while it stands (a later change of the row pitch resizes none).
 * It is sized from what it replaced: the entries of the read's previous
 * layout between its surviving neighbours (the nearest entries before and
 * after it present in both layouts) — the released rows, at their measured
 * advances (`useVisibleRowKeys`: top to next entry's top, so the sum is the
 * span they covered, whatever the view's layout), and any placeholder that
 * left with them, at its own height. Several placeholders appearing between
 * the same neighbours share that span, row for row when their counts match it,
 * else in proportion to their rows. A placeholder with nothing measured to
 * replace (a page released before it was drawn, a new read) is its rows at the
 * pitch; so is a row never measured inside a replaced span.
 */
export function usePlaceholderHeights(
  reads: readonly PagedReadLayout[],
  advances: ReadonlyMap<string, number>,
  pitch: number | null,
): (p: DataViewPagePlaceholder) => number {
  const [state, setState] = useState(() => ({
    reads,
    sized: placeholderHeights([], new Map(), reads, advances, pitch),
  }));
  let sized = state.sized;
  // Keyed on the layout's content, not its identity: a render-phase update
  // re-renders at once, so an input re-minted each render would loop forever.
  if (state.reads !== reads && !sameLayouts(state.reads, reads)) {
    // Derived from the previous render's layout: sized in the render the
    // placeholder appears in, so its first frame already has its height.
    sized = placeholderHeights(
      state.reads,
      state.sized,
      reads,
      advances,
      pitch,
    );
    setState({ reads, sized });
  }
  const fallback = pitch ?? DEFAULT_ROW_PITCH;
  return (p) => {
    const s = sized.get(p.key);
    if (s === undefined) return p.rows * fallback;
    return s.rows === p.rows || s.rows === 0 ? s.px : (s.px * p.rows) / s.rows;
  };
}

/** Whether two layouts list the same entries and placeholders. */
function sameLayouts(
  a: readonly PagedReadLayout[],
  b: readonly PagedReadLayout[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((ra, i) => {
    const rb = b[i]!;
    return (
      ra.id === rb.id &&
      ra.keys.length === rb.keys.length &&
      ra.keys.every((k, j) => k === rb.keys[j]) &&
      ra.placeholders.length === rb.placeholders.length &&
      ra.placeholders.every(
        (p, j) =>
          p.key === rb.placeholders[j]!.key &&
          p.rows === rb.placeholders[j]!.rows,
      )
    );
  });
}

/**
 * The pure half of {@link usePlaceholderHeights}: every placeholder of `next`
 * sized — kept from `prevSized` when it already stood, else sized from what it
 * replaced in `prev`. Exported for its tests.
 */
export function placeholderHeights(
  prev: readonly PagedReadLayout[],
  prevSized: ReadonlyMap<string, Sized>,
  next: readonly PagedReadLayout[],
  advances: ReadonlyMap<string, number>,
  pitch: number | null,
): Map<string, Sized> {
  const fallback = pitch ?? DEFAULT_ROW_PITCH;
  const out = new Map<string, Sized>();
  for (const read of next) {
    const before = prev.find((r) => r.id === read.id);
    const rowsOf = new Map(read.placeholders.map((p) => [p.key, p.rows]));
    const prevIndex = new Map(before?.keys.map((k, i) => [k, i]) ?? []);
    /** Stood in the previous layout of this read, already sized. */
    const stood = (k: string) => prevIndex.has(k) && prevSized.has(k);
    const nextKeys = new Set(read.keys);
    const keys = read.keys;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i]!;
      const rows = rowsOf.get(key);
      if (rows === undefined) continue; // a row
      if (stood(key)) {
        out.set(key, prevSized.get(key)!);
        continue;
      }
      // A run of placeholders new in this layout, between two survivors.
      let end = i;
      while (
        end + 1 < keys.length &&
        rowsOf.has(keys[end + 1]!) &&
        !stood(keys[end + 1]!) &&
        !prevIndex.has(keys[end + 1]!)
      ) {
        end++;
      }
      const run = keys
        .slice(i, end + 1)
        .map((k) => ({ key: k, rows: rowsOf.get(k)! }));
      const replaced =
        before === undefined
          ? null
          : replacedSpan(
              before,
              prevIndex,
              keys[i - 1],
              keys[end + 1],
              nextKeys,
            );
      for (const [k, s] of sizeRun(
        run,
        replaced,
        before,
        prevSized,
        advances,
        fallback,
      )) {
        out.set(k, s);
      }
      i = end;
    }
  }
  return out;
}

/**
 * The entries of the previous layout strictly between the run's neighbours —
 * `null` when they are not a clean replacement: a neighbour that did not
 * survive, no neighbour at all, or an entry of the span still present now
 * (moved, not released).
 */
function replacedSpan(
  before: PagedReadLayout,
  prevIndex: ReadonlyMap<string, number>,
  left: string | undefined,
  right: string | undefined,
  nextKeys: ReadonlySet<string>,
): readonly string[] | null {
  if (left === undefined && right === undefined) return null;
  const lo = left === undefined ? -1 : prevIndex.get(left);
  const hi = right === undefined ? before.keys.length : prevIndex.get(right);
  if (lo === undefined || hi === undefined || hi <= lo) return null;
  const span = before.keys.slice(lo + 1, hi);
  return span.some((k) => nextKeys.has(k)) ? null : span;
}

function sizeRun(
  run: readonly { key: string; rows: number }[],
  replaced: readonly string[] | null,
  before: PagedReadLayout | undefined,
  prevSized: ReadonlyMap<string, Sized>,
  advances: ReadonlyMap<string, number>,
  fallback: number,
): [string, Sized][] {
  const atPitch = run.map((p): [string, Sized] => [
    p.key,
    { px: p.rows * fallback, rows: p.rows },
  ]);
  if (replaced === null || replaced.length === 0 || before === undefined)
    return atPitch;
  // What the span held, entry by entry: a row (its advance) or a placeholder
  // that left with it (its height, its rows).
  const prevRows = new Map(before.placeholders.map((p) => [p.key, p.rows]));
  const chunks = replaced.map((k) => {
    const rows = prevRows.get(k);
    if (rows === undefined) return { rows: 1, px: advances.get(k) ?? fallback };
    return { rows, px: prevSized.get(k)?.px ?? rows * fallback };
  });
  const total = chunks.reduce((n, c) => n + c.px, 0);
  const spanRows = chunks.reduce((n, c) => n + c.rows, 0);
  const runRows = run.reduce((n, p) => n + p.rows, 0);
  if (runRows === spanRows) {
    // Row for row: each placeholder takes the next `rows` rows of the span.
    const out: [string, Sized][] = [];
    let c = 0;
    let left = chunks[0]?.rows ?? 0;
    for (const p of run) {
      let px = 0;
      let need = p.rows;
      while (need > 0 && c < chunks.length) {
        const take = Math.min(need, left);
        px += (chunks[c]!.px * take) / chunks[c]!.rows;
        need -= take;
        left -= take;
        if (left === 0) left = chunks[++c]?.rows ?? 0;
      }
      out.push([p.key, { px, rows: p.rows }]);
    }
    return out;
  }
  return run.map((p) => [
    p.key,
    {
      px: runRows === 0 ? total / run.length : (total * p.rows) / runRows,
      rows: p.rows,
    },
  ]);
}
