import { index } from "drizzle-orm/pg-core";
import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { customColumnValuesEntityRef } from "../../core";

/**
 * Generic per-row custom-column VALUES, keyed by `(dataViewId, rowKey, columnId)`.
 * Works for ANY DataView regardless of its backing data source: `dataViewId` is
 * the surface (`storageKey`), `rowKey` the consumer's `rowKey(row)`, `columnId`
 * the custom-column def id. `value` is v1 text (widen to jsonb later via a
 * migration when non-text field types land).
 *
 * Declared through `defineEntity` from the one field record in
 * `../../core/internal/resource.ts`, so the live read (`customColumnValues`) is
 * a collection `from` it — the same DDL the hand-written `pgTable` had.
 */
export const customColumnValuesEntity = defineEntity(
  customColumnValuesEntityRef,
  {
    primaryKey: ["dataViewId", "rowKey", "columnId"],
    columns: {
      createdAt: { default: defaultNow() },
      updatedAt: { default: defaultNow() },
    },
    updatedAt: {
      touchedBy: {
        value: true,
        dataViewId: false,
        rowKey: false,
        columnId: false,
        createdAt: false,
      },
    },
    indexes: (t) => [index("dvcv_data_view_id_idx").on(t.dataViewId)],
  },
);

// drizzle-kit schema-glob discovery, and the name every writer uses.
export const _dataViewCustomValues = customColumnValuesEntity.table;
