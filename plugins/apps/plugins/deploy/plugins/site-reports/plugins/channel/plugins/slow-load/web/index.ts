import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { SlowLoadReporter } from "./components/slow-load-reporter";

export default {
  description:
    "A site page's slow load as a report: judged once per page load from the boot trace (first byte, first paint, the route's content commit) — judged only on what the visitor could see (boot-trace's readPageShown: a hide recorded from the navigation's start, prerendering): ready at or past 3 s, or hidden before ready after 3 s — and filed through report() as slow-page-load with the coarse browser (family, OS) and network class only; a load hidden before the bar or prerendered is no one's wait, counted as the intake's background-load / prerendered-load drop (countPageDrop). Excluded from every composition (base-exclusions) under its parent channel; the website names it — elsewhere the app's own slow-ops page-load signal covers loads.",
  contributions: [Core.Root({ component: SlowLoadReporter, scope: "page" })],
} satisfies PluginDefinition;
