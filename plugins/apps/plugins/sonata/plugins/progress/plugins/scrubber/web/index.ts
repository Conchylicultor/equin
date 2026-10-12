import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataPlayer } from "@plugins/apps/plugins/sonata/plugins/player/web";
import { ProgressBar } from "./components/progress-bar";
import { SonataProgress } from "./slots";

export { SonataProgress } from "./slots";
export type { BeatSpan, ProgressLabel } from "./slots";
export {
  RAIL_HEIGHT,
  RAIL_BAND_Y,
  railBand,
  ZONE_HEIGHT,
  LABEL_LANE_HEIGHT,
} from "./rail-geometry";

export default {
  description:
    "Sonata Transport: a draggable progression bar for song navigation. Click/drag to seek; hosts the open SonataProgress slots — Marker (rail overlays), Chapters (rail segments), Label (the label lane under the rail) and Describe (hover-preview lines).",
  contributions: [
    // `fill`: the scrubber is the strip's growing cell, between play and loop.
    SonataPlayer.Transport({
      id: "progress-bar",
      component: ProgressBar,
      fill: true,
    }),
  ],
  slots: SonataProgress,
} satisfies PluginDefinition;
