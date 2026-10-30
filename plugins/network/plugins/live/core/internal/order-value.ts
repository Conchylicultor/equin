import type { FilterScalar } from "@plugins/network/plugins/live/plugins/filter/core";

// What a row field must hold for a read to be ordered by it — the ONE
// definition both halves share: the declaration's type (`OrderableKeys`, which
// `sortable`, `default.orderBy` and `all.orderBy` are constrained to) and the
// browser's comparison (`orderScalar`, which a predicted write re-sorts held
// rows by). A field the type admits is a field the comparison reads, so an
// order the browser cannot re-sort is a tsc error at the declaration, not a
// crash in every reader on the first predicted write.

/**
 * A value a read can be ordered by: a scalar, an instant, NULL, or a value
 * object its field's schema decoded from the wire whose `toJSON()` is that
 * wire scalar (a `Rank`, `rankValueField`) — which must order as the column
 * does in SQL (code-point order for text, the cluster's `C` collation).
 */
export type OrderableValue =
  FilterScalar | Date | null | undefined | { toJSON(): FilterScalar };

/** The row fields of `Row` a read may be ordered by (see {@link OrderableValue}). */
export type OrderableKeys<Row> = {
  [K in keyof Row & string]-?: Row[K] extends OrderableValue ? K : never;
}[keyof Row & string];

/**
 * An order field's value as the filter language compares it: an instant as
 * epoch ms, a value object as its wire scalar, NULL as `null`. Throws on
 * anything else — only an untyped declaration reaches that.
 */
export function orderScalar(v: unknown): FilterScalar | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (isScalar(v)) return v;
  if (
    typeof v === "object" &&
    "toJSON" in v &&
    typeof v.toJSON === "function"
  ) {
    const wire: unknown = v.toJSON();
    if (isScalar(wire)) return wire;
  }
  throw new Error(
    `an order field holds ${JSON.stringify(v)} — a read is ordered by scalars, instants or value objects whose toJSON() is a scalar.`,
  );
}

function isScalar(v: unknown): v is FilterScalar {
  return (
    typeof v === "string" || typeof v === "number" || typeof v === "boolean"
  );
}
