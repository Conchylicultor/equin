import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { RecordPlayObserver } from "./components/record-play-observer";
import { playbackPresentation } from "./internal/presentation";

export default {
  description:
    "Per-song play count + last-played: records a play on playback start (Sonata.Effect), and presents the Plays / Last-played fields its extension exposes on every list of songs — on the library card, in the DataView's sort and filter pills, and as table columns.",
  contributions: [
    Sonata.Effect({ id: "record-play", component: RecordPlayObserver }),
    playbackPresentation,
  ],
} satisfies PluginDefinition;
