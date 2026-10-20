import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { useHasChords } from "@plugins/apps/plugins/sonata/plugins/document/web";
import { Sonata } from "@plugins/apps/plugins/sonata/plugins/shell/web";
import { CircleOfFifths } from "./components/circle-of-fifths";
import { sonataIcons } from "@plugins/apps/plugins/sonata/plugins/primitives/plugins/icons/core";

export default {
  description:
    "Sonata Section: a small circle-of-fifths wheel — major keys on the outer ring, their relative minors on the inner ring — that highlights the chord under the playback cursor, reading the session's Score + cursor (useSession).",
  contributions: [
    Sonata.Section({
      id: "circle-of-fifths",
      label: "Circle of fifths",
      icon: sonataIcons.icon("harmony"),
      component: CircleOfFifths,
      area: "player",
      useAvailable: useHasChords,
    }),
  ],
} satisfies PluginDefinition;
