import { compareValues, valuePosition } from "../../core";
import type { FieldGrouping, FieldGroupingSet } from "../../core";

/**
 * The built-in grouping every field falls back to: one section per distinct
 * value, labelled by the value itself, sections in value order.
 *
 * It is the fallback in two senses. A type that declares no groupings of its own
 * still groups this way (which is what keeps an explicit `groupable: true` on any
 * type working), and the legacy persisted `groupBy: "<fieldId>"` string migrates
 * to `{ fieldId, groupingId: "value" }` — this grouping's id.
 *
 * The ordinal is the value's index in `ctx.values` **sorted by `compareValues`**,
 * which is exactly the old value-sorted section order. Duplicates are frequent
 * (one entry per row), so the map keeps the FIRST index a key is seen at: the
 * ordinals then have gaps but stay monotonic, which is all `GroupBucket.order`
 * promises.
 *
 * An ordinal field (`valueOrder`) orders its sections by each value's declared
 * position instead (`valuePosition` — the sort's own reading), the values it
 * does not list after every listed one, in `compareValues` order.
 */
export const IDENTITY_GROUPING: FieldGrouping = {
  id: "value",
  label: "Value",
  // One section per distinct value.
  oneBucketPerValue: true,
  plan: ({ values, field }) => {
    const declared =
      field.valueOrder === undefined ? null : valuePosition(field.valueOrder);
    const listed = field.valueOrder?.length ?? 0;
    const orderByKey = new Map<string, number>();
    [...values].sort(compareValues).forEach((value, index) => {
      const key = String(value);
      if (!orderByKey.has(key)) {
        orderByKey.set(key, declared?.(value) ?? listed + index);
      }
    });
    return (value) => {
      const key = String(value);
      return {
        key,
        label: key,
        // A value absent from `values` cannot happen (the planner is handed
        // every non-null value), so this is a floor, not a policy.
        order: orderByKey.get(key) ?? Number.MAX_SAFE_INTEGER,
      };
    };
  },
};

/** The set a field type falls back to when it declares no groupings. */
export const IDENTITY_GROUPING_SET: FieldGroupingSet = {
  label: "Group by",
  groupings: [IDENTITY_GROUPING],
};
