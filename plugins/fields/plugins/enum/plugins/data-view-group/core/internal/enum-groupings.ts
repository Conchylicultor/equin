import {
  compareValues,
  valuePosition,
  type FieldGrouping,
  type FieldValue,
  type GroupBucket,
  type GroupingPlanContext,
} from "@plugins/primitives/plugins/data-view/core";

/**
 * The enum type's single grouping: one section per distinct value.
 *
 * `field.options` is the ONE choice-list contract (a custom column's private
 * per-type config is projected onto it when the field is minted), so a section
 * header shows the option's **label** (and its `icon` / `tint`, the header's
 * identity chip) and never its stored value — an opaque
 * minted option id, for a user-authored column.
 *
 * Section order is the field's declared value order when it has one (an
 * ordinal enum, `field.valueOrder` — the order its sort and a live window
 * use, so the sections and the rows agree), else `options` order; values the
 * order does not list are placed
 * **after** every known one and, among themselves, in natural value order. That
 * is deliberate: the option list is the author's own reading order, and a value
 * outside it is either stale data or a column edited since the row was written —
 * it belongs at the end, not interleaved by chance.
 *
 * `compareValues` — data-view's own definition of FieldValue ordering — is what
 * ranks the unknown values, so this cannot drift from the identity grouping's
 * answer to the same question.
 *
 * The `plan`/bucket split is what makes this cheap: the ranked index and the
 * unknown-value ranking are built ONCE per render, not re-derived per row.
 */
function planEnumBuckets(
  ctx: GroupingPlanContext,
): (value: FieldValue) => GroupBucket {
  const options = ctx.field.options ?? [];

  // The values in their section order: the declared value order, else the
  // options'.
  const ranked = ctx.field.valueOrder ?? options.map((o) => o.value);

  // value → its index in `ranked` (first wins, so a duplicated option value
  // keeps the position its first declaration gave it).
  const position = valuePosition(ranked);

  // Every value with no matching option, deduped by bucket key and keeping one
  // representative value to compare on.
  const unknown = new Map<string, FieldValue>();
  for (const value of ctx.values) {
    const key = String(value);
    if (position(key) !== null || unknown.has(key)) continue;
    unknown.set(key, value);
  }
  const unknownOrder = new Map<string, number>();
  [...unknown]
    .sort(([, a], [, b]) => compareValues(a, b))
    .forEach(([key], index) => unknownOrder.set(key, ranked.length + index));

  // A value the plan never saw sorts after every ranked one; nothing but a
  // caller bucketing a value outside `ctx.values` can produce it.
  const lastOrder = ranked.length + unknown.size;

  return (value) => {
    const key = String(value);
    const option = options.find((o) => o.value === key);
    return {
      key,
      label: option?.label ?? String(value),
      order: position(key) ?? unknownOrder.get(key) ?? lastOrder,
      // The option's identity — its glyph and colour — rides the bucket to
      // the section (`DataViewSection.identity`), where the group header draws
      // its chip. Spread only when declared, so an option without one leaves
      // the bucket exactly as it was.
      ...(option?.icon === undefined ? {} : { icon: option.icon }),
      ...(option?.tint === undefined ? {} : { tint: option.tint }),
    };
  };
}

export const enumGroupings: FieldGrouping[] = [
  // One section per stored value: a live source may order its sections by the
  // column itself (stored-value order, as its sort is).
  {
    id: "value",
    label: "Value",
    oneBucketPerValue: true,
    plan: planEnumBuckets,
  },
];
