import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataProgress } from "@plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { SonataPlayer } from "@plugins/apps/plugins/sonata/plugins/player/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { LoopRegion } from "./components/loop-region";
import { LoopRollRegion } from "./components/loop-roll-region";
import { LoopRollEdge } from "./components/loop-roll-edge";
import { LoopToggle } from "./components/loop-toggle";
import { LoopShortcuts } from "./components/loop-shortcuts";
import { LoopOptionsSync } from "./components/loop-options-sync";
import { loopConfig } from "../shared/config";

export default {
  description:
    "Sonata A–B practice loop: a draggable loop region on the progression bar and the piano roll, a Loop split button at the end of the player's transport strip (one-click toggle + repeat options: show the loop ahead, rest one bar before each repeat), and L/[/] shortcuts that cycle playback within [A, B].",
  contributions: [
    SonataProgress.Marker({ id: "loop", component: LoopRegion }),
    Sonata.TransportOverlay({
      id: "loop",
      requires: ["time-axis"],
      component: LoopRollRegion,
    }),
    Sonata.TransportEdge({
      id: "loop",
      requires: ["time-axis"],
      component: LoopRollEdge,
    }),
    // The Loop toggle closes the transport strip, after the scrubber.
    SonataPlayer.Transport({ id: "loop-toggle", component: LoopToggle }),
    Sonata.Effect({ id: "loop-shortcuts", component: LoopShortcuts }),
    // The repeat options (show ahead, rest before repeat): persisted prefs,
    // pushed into the session.
    ConfigV2.WebRegister({ descriptor: loopConfig }),
    Sonata.Effect({ id: "loop-options", component: LoopOptionsSync }),
  ],
} satisfies PluginDefinition;
