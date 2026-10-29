import { matchesFilter } from "@plugins/network/plugins/live/plugins/filter/core";
import {
  LIVE_COLUMNS_KEY,
  type LiveMembership,
} from "@plugins/network/plugins/live/core";
import type { PredictOrder, PredictRow } from "./predict-overlay";

// What a live read of a collection tells the predict overlay about itself
// (`PredictTuple`): which upserted rows it admits, shaped as its own rows,
// and the order a rewritten field re-sorts it by.

/**
 * The entrant function of a read that admits rows `admits` accepts: the
 * predicted row shaped as the collection's rows (exactly its row fields; an
 * entity collection's `$columns` read as their defaults), or `undefined` —
 * not admitted, outside the collection's `membership`, or lacking a field
 * the rows carry (a computed one only the server can fill).
 */
export function entrantOf(
  collection: {
    readonly rowKeys: readonly string[];
    /** The row schema (a zod object) — whether its rows carry `$columns`. */
    readonly row: unknown;
    readonly membership?: LiveMembership | undefined;
  },
  admits: (row: PredictRow) => boolean,
): (row: PredictRow) => PredictRow | undefined {
  const { rowKeys, membership } = collection;
  const carriesColumns = Object.hasOwn(
    (collection.row as unknown as { shape: object }).shape,
    LIVE_COLUMNS_KEY,
  );
  return (row) => {
    if (!admits(row)) return undefined;
    const out: Record<string, unknown> = {};
    for (const k of rowKeys) {
      if (!(k in row)) return undefined;
      out[k] = row[k];
    }
    if (carriesColumns) out[LIVE_COLUMNS_KEY] = {};
    if (
      membership !== undefined &&
      !matchesFilter(out, membership.filter, membership.filterable)
    ) {
      return undefined;
    }
    return out;
  };
}

/**
 * A read's order as row fields (`PredictOrder`), or `undefined` when it names
 * a field its rows do not carry as their own (an exposed or scoped column):
 * the overlay then moves nothing — the server's frame re-sorts.
 */
export function predictOrderOf(
  rowKeys: readonly string[],
  orderBy: readonly (readonly [string, "asc" | "desc"])[] | undefined,
): PredictOrder | undefined {
  if (orderBy === undefined || orderBy.length === 0) return undefined;
  return orderBy.every(([f]) => rowKeys.includes(f)) ? orderBy : undefined;
}
