import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { setCustomColumnValue } from "../../core";
import { _dataViewCustomValues } from "./tables";

/**
 * Upsert a single custom-column cell, or DELETE it when the new value is empty
 * (so clearing a cell leaves no orphan row). Keyed by the composite PK
 * `(dataViewId, rowKey, columnId)`. The write recomputes
 * the `customColumnValues` live value via the L4 DB change-feed.
 */
export const handleSetCustomColumnValue = implement(
  setCustomColumnValue,
  async ({ body }) => {
    const { dataViewId, rowKey, columnId, value } = body;
    if (value === "") {
      await db
        .delete(_dataViewCustomValues)
        .where(
          and(
            eq(_dataViewCustomValues.dataViewId, dataViewId),
            eq(_dataViewCustomValues.rowKey, rowKey),
            eq(_dataViewCustomValues.columnId, columnId),
          ),
        );
      return;
    }
    await db
      .insert(_dataViewCustomValues)
      .values({ dataViewId, rowKey, columnId, value })
      .onConflictDoUpdate({
        target: [
          _dataViewCustomValues.dataViewId,
          _dataViewCustomValues.rowKey,
          _dataViewCustomValues.columnId,
        ],
        // `updatedAt` is derived: the trigger bumps it only when `value` changes.
        set: { value },
      });
  },
);
