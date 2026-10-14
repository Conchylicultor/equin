import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { Reports } from "@plugins/reports/web";
import { slowOpConfig } from "../core";
import { SlowOpCollector } from "./components/slow-op-collector";
import { SlowOpKindView } from "./components/slow-op-kind-view";

export default {
  collapsed: true,
  description:
    "Records slow client operations (page load, element appearance, and every client latency signal — a live update applied, an optimistic write confirmed — split into its phases) into the durable slow-op store via the slow-ops client endpoint.",
  contributions: [
    ConfigV2.WebRegister({ descriptor: slowOpConfig }),
    Core.Root({ component: SlowOpCollector }),
    Reports.KindView({ match: "slow-op", component: SlowOpKindView }),
  ],
} satisfies PluginDefinition;
