import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import {
  SonataDocument,
  swingSetting,
} from "@plugins/apps/plugins/sonata/plugins/document/web";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import {
  FeelSection,
  FeelSwitch,
  useFeelAvailable,
} from "./components/feel-section";
import { SwingChip } from "./components/swing-chip";
import { SwingObserver } from "./components/swing-observer";
import { swingDisplayConfig } from "../shared/config";
import { sonataIcons } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/icons/core";

export { usePerformedScore } from "./use-performed-score";

export default {
  description:
    "Per-song swing feel: persists the song's swing override (straight, or a chosen 8ths/16ths feel) and registers it with the song document's score pipeline (SonataDocument.SongSetting, settled by a headless observer). Sonata Section: Feel — the feel playing and an on/off switch in the header (shown collapsed too), a picture of the swung beats, the unit, the ratio and where the feel comes from. Sonata Hud: a swing chip while the song plays swung. usePerformedScore: the score the falling-note views draw — swung like the audio unless the user turns off \"Swing the falling notes\" (a per-user config, toggled in the Feel section); notation stays straight.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: swingDisplayConfig }),
    SonataDocument.SongSetting({
      id: "swing-sync",
      setting: swingSetting,
      component: SwingObserver,
    }),
    Sonata.Section({
      id: "feel",
      label: "Feel",
      icon: sonataIcons.icon("swing"),
      area: "player",
      component: FeelSection,
      actions: FeelSwitch,
      useAvailable: useFeelAvailable,
    }),
    Sonata.Hud({ id: "swing-chip", component: SwingChip }),
  ],
} satisfies PluginDefinition;
