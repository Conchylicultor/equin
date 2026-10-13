import type {
  LiveCutKey,
  LiveKeyCut,
  LiveKeyDirection,
  LiveKeyRange,
  LivePagedKey,
} from "@plugins/network/plugins/live/core";

// The total order a paged VALUE's items are cut in — the one Postgres gives a
// collection's window, spelled for a source with no SQL: each item's
// key is its order-key parts (exact text, or NULL) then its id. Parts compare
// by code point (the cluster's `C` collation, and the filter language's
// in-memory order), each in its declared direction, a NULL last in either
// direction (the collections' symmetric `NULLS LAST`); the id breaks a tie,
// ascending. The served half checks every loader's answer against it
// (`compile-value.ts`), and a source that holds its whole list in memory
// answers a range with `sliceRange`.

/** A full row key: the order-key parts, then the id. */
export type LiveRowKeyParts = LiveCutKey;

/**
 * `a` vs `b` (each its parts, then the id) in `order`: negative when `a` comes
 * first, 0 for the same key, positive when `b` does. Both must be
 * `order.length + 1` long.
 */
export function compareRowKeys(
  a: LiveRowKeyParts,
  b: LiveRowKeyParts,
  order: readonly LiveKeyDirection[],
): number {
  for (let i = 0; i < order.length; i++) {
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x === y) continue;
    // NULLS LAST, whatever the direction.
    if (x === null) return 1;
    if (y === null) return -1;
    const c = compareCodePoints(x, y);
    return order[i] === "desc" ? -c : c;
  }
  return compareCodePoints(
    a[order.length] as string,
    b[order.length] as string,
  );
}

/** Two strings by code point — not UTF-16 code unit, which orders an astral character before U+E000–U+FFFF. */
function compareCodePoints(x: string, y: string): number {
  if (x === y) return 0;
  const xs = x[Symbol.iterator]();
  const ys = y[Symbol.iterator]();
  for (;;) {
    const a = xs.next();
    const b = ys.next();
    if (a.done) return b.done ? 0 : -1;
    if (b.done) return 1;
    if (a.value !== b.value) {
      return a.value.codePointAt(0)! < b.value.codePointAt(0)! ? -1 : 1;
    }
  }
}

/** A cut's full key: its parts, then its id. */
export function cutParts(cut: LiveKeyCut): LiveRowKeyParts {
  return [...cut.key, cut.id];
}

/** Whether a row key lies in `(after, until]`. */
export function inRange(
  key: LiveRowKeyParts,
  range: Pick<LiveKeyRange, "after" | "until">,
  order: readonly LiveKeyDirection[],
): boolean {
  return (
    (range.after === null ||
      compareRowKeys(key, cutParts(range.after), order) > 0) &&
    (range.until === null ||
      compareRowKeys(key, cutParts(range.until), order) <= 0)
  );
}

/** What `sliceRange` reads off a paged value's declaration. */
export interface PagedOrder<Item> {
  paged: { id: string; key: LivePagedKey<Item> };
}

/**
 * The answer to one page's range for a source that holds its whole list in
 * memory: `items` sorted in the declared order, then the ones in
 * `(after, until]`, at most `limit` — exactly what a paged value's loader
 * must return. `items` need not be sorted; it is not modified.
 */
export function sliceRange<Item>(
  value: PagedOrder<Item>,
  items: readonly Item[],
  range: LiveKeyRange,
): Item[] {
  const { id, key } = value.paged;
  const keyed = items.map((item) => ({
    item,
    parts: [...key.of(item), (item as Record<string, unknown>)[id] as string],
  }));
  keyed.sort((a, b) => compareRowKeys(a.parts, b.parts, key.order));
  const out: Item[] = [];
  for (const k of keyed) {
    if (out.length >= range.limit) break;
    if (inRange(k.parts, range, key.order)) out.push(k.item);
  }
  return out;
}
