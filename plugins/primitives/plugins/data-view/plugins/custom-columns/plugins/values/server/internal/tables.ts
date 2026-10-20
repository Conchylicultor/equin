import {
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { deriveUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";

/**
 * Generic per-row custom-column VALUES, keyed by `(dataViewId, rowKey, columnId)`.
 * Works for ANY DataView regardless of its backing data source: `dataViewId` is
 * the surface (`storageKey`), `rowKey` the consumer's `rowKey(row)`, `columnId`
 * the custom-column def id. `value` is v1 text (widen to jsonb later via a
 * migration when non-text field types land).
 */
export const _dataViewCustomValues = deriveUpdatedAt(
  pgTable(
    "data_view_custom_values",
    {
      dataViewId: text("data_view_id").notNull(),
      rowKey: text("row_key").notNull(),
      columnId: text("column_id").notNull(),
      value: text("value").notNull(),
      createdAt: timestamp("created_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .defaultNow()
        .notNull(),
    },
    (t) => [
      primaryKey({ columns: [t.dataViewId, t.rowKey, t.columnId] }),
      index("dvcv_data_view_id_idx").on(t.dataViewId),
    ],
  ),
  {
    touchedBy: {
      value: true,
      dataViewId: false,
      rowKey: false,
      columnId: false,
      createdAt: false,
    },
  },
);
