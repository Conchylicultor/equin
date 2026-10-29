import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { patchValue } from "@plugins/network/plugins/live/core";
import { customColumnValues } from "./resource";

export const SetCustomColumnValueBodySchema = z.object({
  dataViewId: z.string(),
  rowKey: z.string(),
  columnId: z.string(),
  /** Empty string deletes the cell, so clearing leaves no orphan empty row. */
  value: z.string(),
});
export type SetCustomColumnValueBody = z.infer<
  typeof SetCustomColumnValueBodySchema
>;

/** Upsert (or delete-on-empty) a single custom-column cell value. */
export const setCustomColumnValue = defineEndpoint({
  route: "POST /api/data-view/custom-values",
  body: SetCustomColumnValueBodySchema,
  // The surface's cell list gains, replaces or (for an empty value) loses the cell.
  effect: (on) =>
    patchValue(
      on,
      customColumnValues,
      ({ body }) => ({ dataViewId: body.dataViewId }),
      (cells, { body }) => {
        const others = cells.filter(
          (c) => !(c.rowKey === body.rowKey && c.columnId === body.columnId),
        );
        return body.value === ""
          ? others
          : [
              ...others,
              {
                rowKey: body.rowKey,
                columnId: body.columnId,
                value: body.value,
              },
            ];
      },
    ),
});

export const DeleteCustomColumnValuesBodySchema = z.object({
  dataViewId: z.string(),
  columnId: z.string(),
});
export type DeleteCustomColumnValuesBody = z.infer<
  typeof DeleteCustomColumnValuesBodySchema
>;

/** Delete every per-row value for one column across a surface (column removal). */
export const deleteCustomColumnValues = defineEndpoint({
  route: "POST /api/data-view/custom-values/delete-column",
  body: DeleteCustomColumnValuesBodySchema,
  effect: (on) =>
    patchValue(
      on,
      customColumnValues,
      ({ body }) => ({ dataViewId: body.dataViewId }),
      (cells, { body }) => cells.filter((c) => c.columnId !== body.columnId),
    ),
});
