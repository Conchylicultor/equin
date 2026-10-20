import { and, eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { deleteCustomColumnValues } from "../../core";
import { _dataViewCustomValues } from "./tables";

/**
 * Delete every per-row value for one custom column across a surface (column
 * removal), keyed by `(dataViewId, columnId)` — no `rowKey` predicate, so it
 * clears the column across all rows. The write recomputes
 * the `customColumnValues` live value via the L4 DB change-feed.
 */
export const handleDeleteCustomColumnValues = implement(
  deleteCustomColumnValues,
  async ({ body }) => {
    const { dataViewId, columnId } = body;
    await db
      .delete(_dataViewCustomValues)
      .where(
        and(
          eq(_dataViewCustomValues.dataViewId, dataViewId),
          eq(_dataViewCustomValues.columnId, columnId),
        ),
      );
  },
);
