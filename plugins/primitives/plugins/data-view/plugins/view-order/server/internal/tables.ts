import { index } from "drizzle-orm/pg-core";
import {
  defaultNow,
  defineEntity,
} from "@plugins/infra/plugins/entities/server";
import { rowOrderEntityRef } from "../../core";

/**
 * Generic per-view-instance manual ROW ORDER, keyed by
 * `(dataViewId, viewId, rowKey)`. Works for ANY DataView regardless of its
 * backing data source: `dataViewId` is the surface (`storageKey`), `viewId` the
 * view **instance** that owns this order (two instances of the same surface hold
 * different orders), `rowKey` the consumer's `rowKey(row, 0)`.
 *
 * `rowKey` is an opaque string, NOT a foreign key — a DB cascade is impossible,
 * so a deleted row leaves a stale entry until the view's next reorder replaces
 * the set. Identical bounded-table posture as `data_view_custom_values`; see this
 * plugin's CLAUDE.md § Retention.
 *
 * Declared through `defineEntity` from the one field record in
 * `../../core/internal/resource.ts`, so the live read (`rowOrder`) is a
 * collection `from` it — the same DDL the hand-written `pgTable` had.
 */
export const rowOrderEntity = defineEntity(rowOrderEntityRef, {
  primaryKey: ["dataViewId", "viewId", "rowKey"],
  columns: {
    createdAt: { default: defaultNow() },
    updatedAt: { default: defaultNow() },
  },
  updatedAt: {
    touchedBy: {
      rank: true,
      dataViewId: false,
      viewId: false,
      rowKey: false,
      createdAt: false,
    },
  },
  indexes: (t) => [index("dvro_view_idx").on(t.dataViewId, t.viewId)],
});

// drizzle-kit schema-glob discovery, and the name every writer uses.
export const _dataViewRowOrder = rowOrderEntity.table;
