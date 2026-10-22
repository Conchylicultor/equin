import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Stats } from "@plugins/stats/web";
import { ConfigV2 } from "@plugins/config_v2/web";
import { CommitsSection } from "./components/commits-section";
import { LinesChartsSection } from "./components/lines-charts";
import { commitsConfig } from "../shared/config";

export {
  ChartState,
  axisProps,
  yAxisFormatter,
  tooltipNumberFormatter,
  tooltipContentStyle,
  tooltipLabelStyle,
  lineCursor,
  barCursor,
  gridProps,
  fillGaps,
} from "./components/chart-primitives";
export { LiveChart } from "./components/live-chart";
export type { LiveChartSize } from "./components/live-chart";

export default {
  description: "Commit-based stats: commits and lines of change over time.",
  contributions: [
    Stats.Chart({
      id: "commits",
      title: "Commits",
      component: CommitsSection,
    }),
    Stats.Chart({
      id: "lines",
      title: "Lines changed",
      component: LinesChartsSection,
    }),
    ConfigV2.WebRegister({ descriptor: commitsConfig }),
  ],
} satisfies PluginDefinition;
