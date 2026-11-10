import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { LatencyCollector } from "./components/latency-collector";

export default {
  description:
    "The browser half of the latency ledger: times every page load and in-app navigation until every list on screen has its data, and the delay of every update pushed into the tab, and posts them as per-minute histograms at most once a minute.",
  contributions: [Core.Root({ component: LatencyCollector, scope: "page" })],
} satisfies PluginDefinition;
