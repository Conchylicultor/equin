import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import type { BuildingSpec } from "../core";

/** One app's bespoke building on Isle. */
export interface IsleBuildingContribution {
  /** The app it houses (its `id` is the key: one building per app). */
  readonly app: AppRef;
  readonly building: BuildingSpec;
}

/**
 * The building registry (collection-consumer). An app contributes its own
 * building from its own deferred `isle-building` sub-plugin; Isle reads them
 * through `useIsleBuildings()` and never names an app. An app with no
 * contribution gets a generated `kitBuilding`.
 */
export const Isle = {
  Building: defineSlot<IsleBuildingContribution>({
    docLabel: (p) => p.app.id,
  }),
};
