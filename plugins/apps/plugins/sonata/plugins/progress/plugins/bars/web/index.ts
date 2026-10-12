import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { SonataProgress } from "@plugins/apps/plugins/sonata/plugins/progress/plugins/scrubber/web";
import { BarTicks } from "./components/bar-ticks";
import { describeBar } from "./components/bar-describe";

export default {
  description:
    "Sonata progress marker: bar notches cut into the progression rail at every bar line (every 4th bar stronger), derived from the score's time signatures via bars(), plus the hover preview's `Bar n` readout.",
  contributions: [
    SonataProgress.Marker({ id: "bars", component: BarTicks }),
    SonataProgress.Describe({
      id: "bars",
      order: 0,
      line: "head",
      describe: describeBar,
    }),
  ],
} satisfies PluginDefinition;
