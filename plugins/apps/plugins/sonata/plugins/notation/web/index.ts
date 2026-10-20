import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { SonataPlayer } from "@plugins/apps/plugins/sonata/plugins/player/web";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { lazyComponent } from "@plugins/primitives/plugins/lazy-component/web";
import { notationConfig } from "../shared/config";
import { sonataIcons } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/icons/core";

export default {
  description:
    "Sonata Display: standard staff notation. Engraves the score as a grand staff (treble + bass) with clefs, key/time signatures, barlines, accidentals and rests, following playback with a moving playhead, active-note highlight and auto-scroll. A reading view (no time-axis / pitch-plane capabilities); click a note to seek.",
  contributions: [
    // `match` is the dispatch key the player selects on (`key: activeDisplayId`);
    // it equals `id` so the picker's id and the dispatch key stay in lockstep.
    // No capabilities: a reading view publishes no pixel geometry, so the
    // capability-filtered overlays / pitch-axis correctly don't mount here.
    SonataPlayer.Display({
      match: "notation",
      id: "notation",
      label: "Notation",
      icon: sonataIcons.icon("notation"),
      capabilities: [],
      // Lazy-loaded so VexFlow (the heavy engraving library reached through
      // `./components/notation` → `./components/engrave`) is code-split off the
      // eager plugin-boot wave and only downloaded when the notation display is
      // first mounted. Its own Suspense boundary shows a spinner meanwhile.
      component: lazyComponent(() =>
        import("./components/notation").then((m) => ({ default: m.Notation })),
      ),
    }),
    ConfigV2.WebRegister({ descriptor: notationConfig }),
    // Surface the notation prefs in the player's view-options chip.
    Sonata.ViewOption({
      id: "notation",
      displays: ["notation"],
      config: notationConfig,
      fields: ["staffLayout", "showChordSymbols"],
    }),
  ],
} satisfies PluginDefinition;
