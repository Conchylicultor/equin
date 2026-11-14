import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Isle } from "./slots";

export { Isle } from "./slots";
export type { IsleBuildingContribution } from "./slots";
export { useIsleBuildings } from "./use-isle-buildings";

export default {
  description:
    "Isle's building contract (BuildingSpec: a declared footprint, preferred setting, sign, night lights, paint/animate on any 2D context), the watercolour-and-ink painting kit bespoke buildings reuse, and kitBuilding \u2014 a generated building per app, seeded from its id and shaped by its category. Its testing barrel measures a painter's ink without a canvas. Isle.Building: the slot an app contributes its bespoke building to (keyed by its AppRef, from its own isle-building sub-plugin); useIsleBuildings reads them by app id, loading until the deferred tier has settled.",
  slots: Isle,
} satisfies PluginDefinition;
