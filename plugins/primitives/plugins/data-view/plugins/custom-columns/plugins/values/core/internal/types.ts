import { z } from "zod";

/**
 * One persisted custom-column VALUE row for a DataView surface. The full key is
 * `(dataViewId, rowKey, columnId)`; the resource is already scoped to one
 * `dataViewId`, so the live payload carries only the remaining coordinates.
 */
export interface CustomColumnValueRow {
  rowKey: string;
  columnId: string;
  value: string;
}

export const CustomColumnValueRowSchema = z.object({
  rowKey: z.string(),
  columnId: z.string(),
  value: z.string(),
});
