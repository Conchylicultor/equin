import type {
  FieldDef,
  FieldGrouping,
  FieldValue,
  GroupBucket,
} from "@plugins/primitives/plugins/data-view/core";

/**
 * The bool type's single grouping: a **No** section and a **Yes** section.
 *
 * `key` stays `String(value)` — the identity data-view bucketed on before this
 * moved out of the primitive — so a collapsed section survives the change.
 * Order puts `false` first, matching the type's own `asc` reading ("Unchecked
 * first", `boolIdentity.directionLabels`).
 *
 * A field names its two sections through its own `options` (`value` `"true"`
 * / `"false"`) — the notifications pane's `read` reads "Unread" / "Read",
 * not "No" / "Yes"; a field declaring none gets Yes / No.
 */
function bucketBool(
  field: FieldDef<unknown>,
): (value: FieldValue) => GroupBucket {
  const labelOf = (v: boolean): string =>
    field.options?.find((o) => o.value === String(v))?.label ??
    (v ? "Yes" : "No");
  const yes = labelOf(true);
  const no = labelOf(false);
  return (value) => ({
    key: String(value),
    label: value ? yes : no,
    order: value ? 1 : 0,
  });
}

export const boolGroupings: FieldGrouping[] = [
  // One section per value, No before Yes — the order SQL gives `false`, `true`.
  {
    id: "value",
    label: "Value",
    oneBucketPerValue: true,
    plan: ({ field }) => bucketBool(field),
  },
];
