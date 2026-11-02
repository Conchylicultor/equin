import type { WireCodec } from "@plugins/database/plugins/sql-column/server";
import { liveReadCode } from "@plugins/infra/plugins/query-resource/core";

// A served row's encode and `$columns` fold — their own small module because
// they are code a handed-over `:rows` tuple's value and a persisted `all`
// value depend on (`liveReadCode`): a change here reloads them after a restart
// instead of inheriting rows encoded the old way. Keep its imports narrow (types, and the source set): everything it
// loads moves that digest. The `$columns` key is handed in, not imported, for
// the same reason (the row schema a definition describes already names it).
liveReadCode.include(import.meta);

/**
 * Move each exposed field out of its flat wire name into
 * `out[columnsKey][set][field]` — every set present, even with no field
 * projected (the row schema requires the slice). Mutates `out`.
 */
export function foldColumns(
  out: Record<string, unknown>,
  sets: readonly string[],
  foldedFields: ReadonlyMap<string, { set: string; field: string }>,
  columnsKey: string,
): void {
  const cols: Record<string, Record<string, unknown>> = Object.fromEntries(
    sets.map((s) => [s, {}]),
  );
  for (const [wire, { set, field }] of foldedFields) {
    cols[set]![field] = out[wire];
    delete out[wire];
  }
  out[columnsKey] = cols;
}

export interface RowEncodeInput {
  /** Every exposed set the rows carry, in order (each present on every row). */
  sets: readonly string[];
  /** A projected wire name → the exposed set and field it folds into. */
  foldedFields: ReadonlyMap<string, { set: string; field: string }>;
  /** Projected fields whose column type has a wire form, with its codec. */
  wired: readonly [string, WireCodec<unknown, unknown>][];
  /** Whether rows reach exposures (fold into `columnsKey`). */
  foldsColumns: boolean;
  /** The row key the exposed sets fold under (network/live's `LIVE_COLUMNS_KEY`). */
  columnsKey: string;
}

/**
 * What a row goes through between the loader and the wire: each wired field
 * encoded, then the exposed sets' flat wire-named values folded into
 * `row[columnsKey][set][field]` (every set present). Nothing to do ⇒ no
 * `encodeRow`. `encodeRowId` says what `encodeRow` does as data, for the
 * point read's definition: the fold alone is fixed by which wire field lands
 * where. A wire codec's `encode` is code no id names, so a row with one has no
 * id (its point read is never inherited across a restart).
 */
export function rowEncodeOf(input: RowEncodeInput): {
  encodeRow?: (row: Record<string, unknown>) => Record<string, unknown>;
  encodeRowId?: string;
} {
  const { sets, foldedFields, wired, foldsColumns, columnsKey } = input;
  if (wired.length === 0 && !foldsColumns) return {};
  const encodeRow = (row: Record<string, unknown>): Record<string, unknown> => {
    const out = { ...row };
    for (const [name, codec] of wired) {
      const value = out[name];
      if (value !== null && value !== undefined) {
        out[name] = codec.encode(value);
      }
    }
    if (foldsColumns) foldColumns(out, sets, foldedFields, columnsKey);
    return out;
  };
  if (wired.length > 0) return { encodeRow };
  return {
    encodeRow,
    encodeRowId: `fold:${JSON.stringify({
      sets,
      fields: [...foldedFields]
        .map(([wire, { set, field }]) => [wire, set, field])
        .sort(([a], [b]) => (a! < b! ? -1 : a! > b! ? 1 : 0)),
    })}`,
  };
}
