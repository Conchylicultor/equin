import { Rank } from "@plugins/primitives/plugins/rank/core";

/**
 * Carry row identity across a recompute: each row of `next` whose fields all
 * equal those of the previous row with the same `id` is replaced by that
 * previous object, and when every row is kept in the same order the previous
 * ARRAY is returned. The queue rebuilds every row on each recompute (the
 * classification spreads each conversation into a new object), which threw
 * away the identity `useLive` keeps for unchanged rows — and a list memoizes
 * each row on its row object, so one conversation changing re-rendered all of
 * them.
 *
 * Fields compare by reference, except two value types a recompute re-mints
 * with no change: a `Rank` (the optimistic overlay replays ranks into fresh
 * objects) and a `Date`.
 */
export function reuseRows<TRow extends { id: string }>(
  prev: readonly TRow[] | null,
  next: TRow[],
): TRow[] {
  if (prev === null) return next;
  const byId = new Map<string, TRow>();
  for (const row of prev) byId.set(row.id, row);
  let samePositions = prev.length === next.length;
  const out = next.map((row, i) => {
    const old = byId.get(row.id);
    const kept = old !== undefined && sameFields(old, row) ? old : row;
    if (kept !== prev[i]) samePositions = false;
    return kept;
  });
  return samePositions ? (prev as TRow[]) : out;
}

function sameFields(a: object, b: object): boolean {
  if (a === b) return true;
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  const ar = a as Record<string, unknown>;
  const br = b as Record<string, unknown>;
  return ak.every((k) => Object.hasOwn(br, k) && sameValue(ar[k], br[k]));
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a instanceof Rank && b instanceof Rank) return Rank.equals(a, b);
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime();
  return false;
}
