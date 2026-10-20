import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { lazyComponent } from "@plugins/primitives/plugins/lazy-component/web";
import { SonataPlayer } from "@plugins/apps/plugins/sonata/plugins/player/web";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { sonataPlayerPane } from "@plugins/apps/plugins/sonata/plugins/library/web";
import { SpreadWheel } from "./components/spread-wheel";
import { pianoRollConfig } from "../shared/config";
import { PianoRollFx } from "./slots";
import { FxViewSection } from "./components/fx-view-section";
import { symbol } from "@plugins/ui/plugins/icons/core";

// The FX extension point: effect sub-plugins import these from this barrel
// (the only legal cross-plugin path) and contribute headless effects.
export { PianoRollFx } from "./slots";
export type { FxToggleConfig, FxNoteEvent, FxContext } from "./slots";
// The particle-pool types effects build on. `createEmitter` itself is NOT
// re-exported here: it is pixi-bearing, and a static value re-export would drag
// pixi.js into the eager plugin-boot wave. Effects call `fx.createEmitter(...)`
// off the FxContext instead — the host (piano-roll, lazy-loaded) owns the pixi
// coupling, so the pool ships in the lazy piano-roll chunk, not at boot.
export type {
  ParticleEmitter,
  EmitterOptions,
  SpawnSpec,
} from "./internal/fx/particles";
export { easeOutCubic } from "./internal/fx/particle-step";

export default {
  description:
    "Sonata Display: Synthesia-like pitch × time piano roll. Draws notes via its published Projection (time-axis + pitch-plane capabilities), auto-scrolls the time axis to keep the playback cursor in view, and hosts capability-compatible overlays.",
  contributions: [
    // `match` is the dispatch key the player selects on (`key: activeDisplayId`).
    // It equals `id` here so the picker's id and the dispatch key stay in lockstep.
    SonataPlayer.Display({
      match: "piano-roll",
      id: "piano-roll",
      label: "Piano roll",
      icon: symbol("graphic-eq"),
      capabilities: ["time-axis", "pitch-plane"],
      // The default lens when the user hasn't picked one.
      default: true,
      // Its ground and bar rules run under the player's dock; the keys keep
      // beside it (`useDisplayCover`).
      bleed: true,
      // Lazy: the piano-roll draws via pixi.js, a heavy dep. Code-splitting it
      // here keeps pixi off the eager plugin-boot wave — it loads only when a
      // user actually opens the (non-default) Sonata piano-roll display.
      component: lazyComponent(() =>
        import("./components/piano-roll").then((m) => ({
          default: m.PianoRoll,
        })),
      ),
    }),
    // Toolbar jog wheel for the roll's vertical zoom (spread), in the toolbar's
    // End zone beside the transport controls. Lives in this plugin (not
    // transport-bar) so it can own the private spread config it persists; the
    // live value is shared via the Sonata transport context.
    sonataPlayerPane.Actions({ id: "spread", component: SpreadWheel }),
    ConfigV2.WebRegister({ descriptor: pianoRollConfig }),
    // Surface the roll's display prefs in the player's view-options chip. Only
    // `showNoteNames` — `spread` is driven live by the toolbar jog wheel above,
    // so a second zoom control would be redundant.
    Sonata.ViewOption({
      id: "piano-roll",
      displays: ["piano-roll"],
      config: pianoRollConfig,
      fields: ["showNoteNames"],
    }),
    // The roll's visual effects, as its own block of the same View options
    // panel (one switch per PianoRollFx contribution, grouped by tier).
    Sonata.ViewSection({
      id: "piano-roll-fx",
      displays: ["piano-roll"],
      component: FxViewSection,
    }),
  ],
  slots: { fx: PianoRollFx },
} satisfies PluginDefinition;
