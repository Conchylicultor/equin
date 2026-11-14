import type { BuildingSpec } from "@plugins/apps/plugins/isle/plugins/buildings/core";
import type { AppCategory } from "@plugins/primitives/plugins/pane/core";
import { signHalfWidth, type Resident } from "./placement";

/** An app and its building, as placement reads them. */
export function residentOf(
  app: {
    readonly id: string;
    readonly name: string;
    readonly category: AppCategory;
  },
  building: BuildingSpec,
): Resident {
  return {
    id: app.id,
    category: app.category,
    footprint: building.footprint,
    setting: building.setting ?? [],
    ...(building.signX !== undefined && { signX: building.signX }),
    signHalf: signHalfWidth(app.name),
  };
}
