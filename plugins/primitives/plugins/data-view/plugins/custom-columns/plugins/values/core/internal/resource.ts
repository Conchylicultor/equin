import type { FieldsRecord } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { liveCollection } from "@plugins/network/plugins/live/core";

/**
 * One persisted custom-column cell: the key `(dataViewId, rowKey, columnId)`
 * and its v1 text `value`.
 */
export const customColumnValueFields = {
  dataViewId: textField(),
  rowKey: textField(),
  columnId: textField(),
  value: textField(),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

/** The `data_view_custom_values` entity — one field record for the table and the wire. */
export const customColumnValuesEntityRef = entityRef(
  "data_view_custom_values",
  customColumnValueFields,
);

/**
 * Live per-surface custom-column values: a scoped whole set
 * (`all: { by: ["dataViewId"] }`), one tuple per surface — every cell of that
 * surface's custom columns, indexed client-side onto each rendered row. Keyed
 * by the table's composite primary key, so a cell written on another surface
 * reaches no tuple (the router skips it on the carried `data_view_id`), and a
 * cell written on this one is a one-row refill shipped as a keyed delta. No
 * placeholder: before the first rows land the read is `pending`.
 *
 * The key is NEW (`data-view-custom-values.v2`; it was the param'd value
 * `data-view-custom-values`): a tab still on a bundle that subscribed the old
 * key gets `unknown-key` — a `skew` verdict, the Reload prompt — instead of
 * parsing keyed deltas its value read cannot apply (C39). Pinned by
 * `../../../../web/__tests__/custom-column-values-old-tab.test.ts`.
 */
export const customColumnValues = liveCollection("data-view-custom-values.v2", {
  from: customColumnValuesEntityRef,
  carry: { pick: ["dataViewId", "rowKey", "columnId", "value"] },
  id: compositeKey(["dataViewId", "rowKey", "columnId"]),
  all: {
    by: ["dataViewId"],
    orderBy: [
      ["rowKey", "asc"],
      ["columnId", "asc"],
    ],
    unbounded: {
      reason:
        "one DataView surface's custom-column cells, indexed client-side onto every rendered row",
    },
  },
});
