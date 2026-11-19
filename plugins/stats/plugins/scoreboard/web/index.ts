import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Stats } from "@plugins/stats/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { ScoreboardSection } from "./components/scoreboard-section";
import { scoreboardPane } from "./components/scoreboard-pane";

export { scoreboardPane } from "./components/scoreboard-pane";

export default {
  description:
    "Stats → Responsiveness trend: is the app getting faster or slower, and is it converging? A one-line verdict, then 35 days of p50 / p95 of what the user feels (your tabs apart from automated ones), memory pressure and restarts, report volume per restart, and weekly new causes, fixes that came back and fixes that landed a guard. Also its own pane (/agents/responsiveness-trend) a supervisor can link to.",
  contributions: [
    Stats.Chart({
      id: "scoreboard",
      title: "Responsiveness trend",
      component: ScoreboardSection,
    }),
    Pane.Register({ pane: scoreboardPane }),
  ],
  slots: { scoreboard: scoreboardPane },
} satisfies PluginDefinition;
