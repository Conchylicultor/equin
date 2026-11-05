import type { FieldDef, FieldValue, SortRule } from "../../core";

/** Coerce a FieldValue to a comparable number|string (Date→ms, bool→0/1, …). */
export function comparable(value: FieldValue): number | string {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "number") return value;
  return String(value ?? "");
}

export function compareScalar(a: number | string, b: number | string): number {
  return typeof a === "number" && typeof b === "number"
    ? a - b
    : String(a).localeCompare(String(b));
}

/**
 * What a sort on a field compares: its value as it compares — or, for an
 * ordinal field (`valueOrder`), the value's position in its declared order,
 * as the server orders a live window by it. A NULL or unlisted value has no
 * position (`null`): it sorts after every listed value in BOTH directions,
 * as the server's NULLS LAST does.
 */
function sortKeyOf<TRow>(
  value: (row: TRow) => FieldValue,
  valueOrder: readonly string[] | undefined,
): (row: TRow) => number | string | null {
  if (valueOrder === undefined) return (row) => comparable(value(row));
  const position = new Map(valueOrder.map((v, i) => [v, i]));
  return (row) => {
    const v = value(row);
    return (typeof v === "string" ? position.get(v) : undefined) ?? null;
  };
}

/**
 * The field ids of the sort rules that do not resolve against `fields` — the
 * field is gone (a deleted custom column, a renamed id, a contributor that did
 * not load) or has no `value` to order by. A view with any is never run with
 * them dropped: the body renders its `rule-error` (`resolveBodyState`, loading
 * while the deferred tier may still contribute the field), the same arm a live
 * source's `UnavailableSortRuleError` takes.
 */
export function unsortableRules<TRow>(
  rules: readonly SortRule[],
  fields: readonly FieldDef<TRow>[],
): string[] {
  return rules
    .filter((rule) => !fields.find((f) => f.id === rule.fieldId)?.value)
    .map((rule) => rule.fieldId);
}

/**
 * Build a stable multi-level comparator from the rule list. Resolves each rule to
 * its field's `value` projection ONCE (outside the hot compare loop). A rule
 * that does not resolve never reaches here in a rendered view — the body
 * refuses it first ({@link unsortableRules}) — so skipping it is only the
 * shape of the loop. Returns `null` when no rule resolves (caller skips
 * sorting → preserves source order).
 *
 * Stability: relies on `Array.prototype.sort` being stable (guaranteed in modern
 * V8/Bun) so a full tie (every rule compares equal) preserves the incoming source
 * order — the implicit final tie-break.
 */
export function makeSortComparator<TRow>(
  rules: SortRule[],
  fields: FieldDef<TRow>[],
): ((a: TRow, b: TRow) => number) | null {
  const resolved = rules
    .map((rule) => {
      const field = fields.find((f) => f.id === rule.fieldId);
      if (!field?.value) return null;
      return {
        key: sortKeyOf(field.value, field.valueOrder),
        dir: rule.direction,
      };
    })
    .filter(
      (
        r,
      ): r is {
        key: (row: TRow) => number | string | null;
        dir: "asc" | "desc";
      } => r !== null,
    );
  if (resolved.length === 0) return null;
  return (a, b) => {
    for (const { key, dir } of resolved) {
      const ka = key(a);
      const kb = key(b);
      // No position (an ordinal's NULL / unlisted value): last either way.
      if (ka === null || kb === null) {
        if (ka !== kb) return ka === null ? 1 : -1;
        continue;
      }
      const cmp = compareScalar(ka, kb);
      if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
    }
    return 0; // full tie → Array.sort stability preserves source/rank order
  };
}
