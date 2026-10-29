import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { PaneMorphHost } from "./components/pane-morph-host";

export default {
  description:
    "The pane → app morph: a pane's cross-app Expand (\"Open in <App>\") runs as a view transition in which the pane grows from its box into the leaf pane of the app that replaces this one — the old app receding, the new one rising, the two apps' sidebars cross-fading in place and the header title gliding between headers, snapshots cropped and never stretched. Installed into the pane primitive's paneMorphSink at Core.Root; falls back to the plain navigation without View Transitions, under reduced motion or mid-morph.",
  contributions: [Core.Root({ component: PaneMorphHost })],
} satisfies PluginDefinition;
