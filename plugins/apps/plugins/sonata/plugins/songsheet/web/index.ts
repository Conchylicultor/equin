import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataPlayer } from "@plugins/apps/plugins/sonata/plugins/player/web";
import { Songsheet } from "./components/songsheet";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Sonata Display: a chord-over-lyrics songsheet. Renders the score's lyric lines with chords printed over each column, grouped by section, highlighting and auto-scrolling the line under the playback cursor. A reading view (no time-axis / pitch-plane capabilities); click a line to seek.",
  contributions: [
    // `match` is the dispatch key the player selects on (`key: activeDisplayId`);
    // it equals `id` so the picker's id and the dispatch key stay in lockstep.
    // No capabilities: a reading view publishes no pixel geometry, so the
    // capability-filtered overlays / pitch-axis correctly don't mount here.
    SonataPlayer.Display({
      match: "songsheet",
      id: "songsheet",
      label: "Songsheet",
      icon: symbol("description"),
      capabilities: [],
      component: Songsheet,
    }),
  ],
} satisfies PluginDefinition;
