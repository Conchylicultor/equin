import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  AccompanimentActions,
  AccompanimentSection,
  useAccompanimentAvailable,
} from "./components/accompaniment-section";

export default {
  description:
    "Sonata Section: Accompaniment — composes the chord-mode row ('Play the detected chords'), the groove (GrooveSwitch in the header, RhythmControls in the body while it is on) and, while the groove is off, the block-chord voicing rows (VoicingControls) into one section, available when chord mode can be offered or the song's chords are voiced.",
  contributions: [
    Sonata.Section({
      id: "accompaniment",
      label: "Accompaniment",
      icon: symbol("graphic-eq"),
      area: "player",
      component: AccompanimentSection,
      actions: AccompanimentActions,
      useAvailable: useAccompanimentAvailable,
    }),
  ],
} satisfies PluginDefinition;
