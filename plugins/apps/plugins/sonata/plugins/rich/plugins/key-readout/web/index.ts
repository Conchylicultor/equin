import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { KeyReadout } from "./components/key-readout";
import { KeyReadoutActions } from "./components/key-readout-actions";
import { symbol } from "@plugins/ui/plugins/icons/core";

export default {
  description:
    "Sonata Section: the current key — its name, relative key and source, the scale as dots on a two-octave readout keyboard plus note-name chips, and (Chords toggle) its seven diatonic chords on readout keyboards — tracking the playback cursor. Reads the session's Score + cursor (useSession).",
  contributions: [
    Sonata.Section({
      id: "key-readout",
      label: "Current key",
      icon: symbol("vpn-key"),
      component: KeyReadout,
      area: "player",
      actions: KeyReadoutActions,
    }),
  ],
} satisfies PluginDefinition;
