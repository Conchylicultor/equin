/** One aligned column as the fit sees it: its width in px and when it yields. */
export interface FitColumn {
  px: number;
  /** `FieldDef.dropOrder`: lower gives way first; absent gives way last. */
  dropOrder?: number;
}

/**
 * Which aligned columns fit beside a label that must keep `minLabel` px.
 *
 * `budget` is the room the label and the columns share: the label's measured
 * width plus every currently shown column's width and gap — the same number
 * whatever subset is shown, so the result never oscillates as columns come
 * and go. Columns give way in `dropOrder`, ascending; those without one go
 * after every numbered column, rightmost first. Returned in their own order.
 *
 * `stacked`: the columns are one column of lines beside the label (a two-line
 * list row's trailing fields), so they take the WIDEST one's width plus one
 * gap rather than the sum — giving way still follows `dropOrder`, and stops
 * once the widest that is left fits.
 */
export function fitAlignedColumns<T extends FitColumn>(
  columns: readonly T[],
  {
    budget,
    gap,
    minLabel,
    stacked = false,
  }: { budget: number; gap: number; minLabel: number; stacked?: boolean },
): T[] {
  const yieldOrder = columns
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        (a.c.dropOrder ?? Infinity) - (b.c.dropOrder ?? Infinity) || b.i - a.i,
    );
  const dropped = new Set<T>();
  const used = (): number => {
    const kept = columns.filter((c) => !dropped.has(c));
    if (kept.length === 0) return 0;
    return stacked
      ? Math.max(...kept.map((c) => c.px)) + gap
      : kept.reduce((sum, c) => sum + c.px + gap, 0);
  };
  for (const { c } of yieldOrder) {
    if (budget - used() >= minLabel) break;
    dropped.add(c);
  }
  return columns.filter((c) => !dropped.has(c));
}
