import type { FieldsRecord } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import {
  rankField,
  rankValueField,
} from "@plugins/fields/plugins/rank/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { compositeKey } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { liveCollection } from "@plugins/network/plugins/live/core";

/**
 * One persisted row-order entry: the key `(dataViewId, viewId, rowKey)` and its
 * rank. `rank` is the raw fractional-index key on the table (`rank_text`, C
 * collation); the wire carries it as the `Rank` value object.
 */
export const rowOrderFields = {
  dataViewId: textField(),
  viewId: textField(),
  rowKey: textField(),
  rank: rankField(),
  createdAt: dateField(),
  updatedAt: dateField(),
} satisfies FieldsRecord;

/** The `data_view_row_order` entity — one field record for the table and the wire. */
export const rowOrderEntityRef = entityRef(
  "data_view_row_order",
  rowOrderFields,
);

/**
 * Live per-view-instance row order: a scoped whole set
 * (`all: { by: ["dataViewId", "viewId"] }`), one tuple per view instance —
 * the rows a user dragged plus the seeds written ahead of them,
 * **rank-ordered**. Keyed by the table's composite primary key, so a drag in
 * another view instance reaches no tuple (the router skips it on the carried
 * `(data_view_id, view_id)`), and a drag in this one is a refill of the rows it
 * wrote, shipped as a keyed delta. No placeholder: before the first rows land
 * the read is `pending`.
 *
 * The key is NEW (`data-view-row-order.v2`; it was the param'd value
 * `data-view-row-order`): a tab still on a bundle that subscribed the old key
 * gets `unknown-key` — a `skew` verdict, the Reload prompt — instead of
 * parsing keyed deltas its value read cannot apply (C39). Pinned by
 * `../../web/__tests__/row-order-old-tab.test.ts`.
 */
export const rowOrder = liveCollection("data-view-row-order.v2", {
  from: rowOrderEntityRef,
  carry: {
    pick: ["dataViewId", "viewId", "rowKey"],
    fields: { rank: rankValueField() },
  },
  id: compositeKey(["dataViewId", "viewId", "rowKey"]),
  all: {
    by: ["dataViewId", "viewId"],
    orderBy: [
      ["rank", "asc"],
      ["rowKey", "asc"],
    ],
    unbounded: {
      reason:
        "one view instance's manual order — the rows a user dragged plus the seeds ahead of them",
      // Measured on main, 2026-11-08: 18 for the largest view.
      budget: 200,
    },
  },
});
