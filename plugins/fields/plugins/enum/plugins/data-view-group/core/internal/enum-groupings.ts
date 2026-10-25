import {
  compareValues,
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
 * Section order is `options` order, with values that match no option placed
 * **after** every known one and, among themselves, in natural value order. That
 * is deliberate: the option list is the author's own reading order, and a value
 * outside it is either stale data or a column edited since the row was written —
 * it belongs at the end, not interleaved by chance.
 *
 * `compareValues` — data-view's own definition of FieldValue ordering — is what
 * ranks the unknown values, so this cannot drift from the identity grouping's
 * answer to the same question.
 *
 * The `plan`/bucket split is what makes this cheap: the `options` index and the
 * unknown-value ranking are built ONCE per render, not re-derived per row.
 */
function planEnumBuckets(
  ctx: GroupingPlanContext,
): (value: FieldValue) => GroupBucket {
  const options = ctx.field.options ?? [];

  // value → its index in `options` (first wins, so a duplicated option value
  // keeps the position its first declaration gave it).
  const knownOrder = new Map<string, number>();
  options.forEach((option, index) => {
    if (!knownOrder.has(option.value)) knownOrder.set(option.value, index);
  });

  // Every value with no matching option, deduped by bucket key and keeping one
  // representative value to compare on.
  const unknown = new Map<string, FieldValue>();
  for (const value of ctx.values) {
    const key = String(value);
    if (knownOrder.has(key) || unknown.has(key)) continue;
    unknown.set(key, value);
  }
  const unknownOrder = new Map<string, number>();
  [...unknown]
    .sort(([, a], [, b]) => compareValues(a, b))
    .forEach(([key], index) => unknownOrder.set(key, options.length + index));

  // A value the plan never saw sorts after every ranked one; nothing but a
  // caller bucketing a value outside `ctx.values` can produce it.
  const lastOrder = options.length + unknown.size;

  return (value) => {
    const key = String(value);
    const option = options.find((o) => o.value === key);
    return {
      key,
      label: option?.label ?? String(value),
      order: knownOrder.get(key) ?? unknownOrder.get(key) ?? lastOrder,
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
