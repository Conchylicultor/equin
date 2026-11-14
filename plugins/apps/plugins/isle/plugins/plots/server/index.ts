import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { claimPlots, movePlot } from "../core";
import { islePlotsServed } from "./internal/resource";
import { handleClaimPlots, handleMovePlot } from "./internal/routes";

export { _islePlots } from "./internal/tables";

export default {
  description:
    "Isle's plots table (isle_plots: one row per plot of a world, keyed (world, plotId), its occupant unique per world, the geometry as jsonb) served as the isle.plots live collection, and the claim / move endpoints: one compare-and-set transaction per batch, answered stale when what the writer read no longer holds.",
  httpRoutes: {
    [claimPlots.route]: handleClaimPlots,
    [movePlot.route]: handleMovePlot,
  },
  contributions: [...islePlotsServed.declare],
} satisfies ServerPluginDefinition;
