import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { CustomColumnDefSchema } from "./types";

/**
 * One DataView surface's custom column DEFINITIONS, as the server reads them
 * from the surface's config — the members of the `custom` scoped column set
 * (see `CUSTOM_COLUMNS_SET`). Served from the config (external: its truth is a
 * file, not a table) and notified when a surface's definitions change, which
 * is what a live collection listed on that surface recomputes on: a column
 * added, dropped or retyped moves the SQL its tuples compiled to.
 */
export const customColumnDefs = liveValue("data-view-custom-column-defs", {
  schema: z.array(CustomColumnDefSchema),
  params: ["dataViewId"],
});

/**
 * The name of the scoped column set custom columns are served as on a live
 * collection (`LiveColumns.Scoped` / `scopedLiveColumns`): a custom column's
 * wire name is `custom.<column id>`.
 */
export const CUSTOM_COLUMNS_SET = "custom";
