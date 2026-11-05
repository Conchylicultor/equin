import type { FieldValue } from "./types";

/**
 * **The single reading of a field's declared value order** (`FieldDef.valueOrder`,
 * an ordinal enum): a value → its position in the order, or `null` for a NULL
 * or a value the order does not list. Every surface that orders a field by it
 * — the in-memory sort, the section order of a grouping, the sort direction's
 * label — reads this, so the rows, the groups and the labels cannot disagree
 * with each other or with the server's window (which orders by the same
 * position, an unlisted value or NULL last).
 *
 * Built once per field (the lookup is a map), then asked per value.
 */
export function valuePosition(
  valueOrder: readonly string[],
): (value: FieldValue) => number | null {
  const position = new Map<string, number>();
  valueOrder.forEach((v, i) => {
    if (!position.has(v)) position.set(v, i);
  });
  return (value) =>
    (typeof value === "string" ? position.get(value) : undefined) ?? null;
}
