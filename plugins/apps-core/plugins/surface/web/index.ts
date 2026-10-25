import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";
import { ActionBar } from "@plugins/shell/plugins/action-bar/web";
import { Surface } from "./slots";
import { SurfaceBody } from "./components/surface-body";
import { ActionBarPlacementControl } from "./components/placement-control";

export {
  Surface,
  PlacementStyleProvider,
  usePlacementStyle,
  type PlacementDef,
  type PlacementChromeProps,
  type PlacementStyleApi,
} from "./slots";

export default {
  description:
    "Generic surface dispatcher: renders every open tab at once under the ONE surface mode (docked / windows / solo) selected from the Surface.Placement registry, so the modes are mutually exclusive. Owns the surface body and the mode control; each mode (docked / floating / solo) is a self-contained sub-plugin.",
  contributions: [
    // The single body that renders every tab under the one surface mode.
    Apps.Surface({ component: SurfaceBody }),
    // The mode control, contributed as an action-bar view option so it renders
    // in the bar's gear popover (docked tab-bar strip and floating overlay).
    ActionBar.ViewOption({
      id: "placement-control",
      component: ActionBarPlacementControl,
      audience: "developer",
    }),
  ],
  slots: Surface,
} satisfies PluginDefinition;
