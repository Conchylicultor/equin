import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { ViewOptionsToggle } from "./components/view-options-toggle";

export {
  useHasViewOptions,
  ViewOptionsPanel,
} from "./components/view-options-toggle";

export default {
  description:
    "Sonata Hud: shared display-options chip. Renders every Sonata.ViewOption contribution generically via FieldRenderer, so the View popover appears in every display lens (piano roll, notation, songsheet), plus each lens's Sonata.ViewSection blocks. Exports the panel's members (ViewOptionsPanel) for a host that opens it from its own trigger — the player toolbar's display switcher.",
  contributions: [Sonata.Hud({ id: "view-options", component: ViewOptionsToggle })],
} satisfies PluginDefinition;
