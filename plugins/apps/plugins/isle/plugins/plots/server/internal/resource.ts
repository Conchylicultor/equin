import { serveCollection } from "@plugins/network/plugins/live/server";
import { islePlots } from "../../core";
import { islePlots as islePlotsTable } from "./tables";

/**
 * Serves `isle.plots`, one tuple per world, compiled from the table: the wire
 * fields only (the timestamps stay server-side). The handlers notify nothing —
 * the change feed carries each write, routed by its `world`, which leads the
 * primary key, so a world's read is an index range.
 */
export const islePlotsServed = serveCollection(islePlots, {
  from: islePlotsTable,
});
