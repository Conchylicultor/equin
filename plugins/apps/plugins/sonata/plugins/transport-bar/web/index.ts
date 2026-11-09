import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  sonataPlayerPane,
  songPeekPane,
} from "@plugins/apps/plugins/sonata/plugins/library/web";
import { SonataPlayer } from "@plugins/apps/plugins/sonata/plugins/player/web";
import { TempoWheel } from "./components/tempo-wheel";
import { PlayButton } from "./components/play-button";

export default {
  description:
    "Sonata transport controls: the play/pause button at the head of the player's transport strip (togglePlay, count-in aware) and the playback-speed jog wheel in the player header (and the song peek's), folded to its readout at rest.",
  contributions: [
    SonataPlayer.Transport({ id: "play", component: PlayButton }),
    sonataPlayerPane.Actions({ id: "speed", component: TempoWheel }),
    songPeekPane.Actions({ id: "speed", component: TempoWheel }),
  ],
} satisfies PluginDefinition;
