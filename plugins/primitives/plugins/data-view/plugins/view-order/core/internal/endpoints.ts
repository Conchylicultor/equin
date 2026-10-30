import { z } from "zod";
import { defineEndpoint } from "@plugins/infra/plugins/endpoints/core";
import { RowOrderRowSchema } from "./types";

export const SetRowOrderBodySchema = z.object({
  dataViewId: z.string(),
  viewId: z.string(),
  /**
   * The **bounded** write set for one drag: the moved row plus any seeds
   * materialized ahead of it, rank-ascending (client-minted — the server cannot
   * reproduce seeds, as it does not know the view's source order). This is NOT a
   * full replace: rows absent from `writes` keep their persisted rank, and
   * nothing is deleted. `.min(1)` because a legitimate no-op is never POSTed
   * (the client skips it).
   */
  writes: z.array(RowOrderRowSchema).min(1),
});
export type SetRowOrderBody = z.infer<typeof SetRowOrderBodySchema>;

/** Upsert a view instance's bounded row-order write set. */
export const setRowOrder = defineEndpoint({
  route: "POST /api/data-view/row-order",
  body: SetRowOrderBodySchema,
});
