import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { MainThreadStallController } from "./components/main-thread-stall-controller";
import { MainThreadStallKindView } from "./components/main-thread-stall-kind-view";
import { SlowInteractionKindView } from "./components/slow-interaction-kind-view";

export default {
  description:
    "Main-thread stall detector: a Core.Root controller that attaches each tab to one out-of-thread SharedWorker watchdog (1 Hz ping, Web Lock per tab, IndexedDB record of an open stall) and feeds it the tab's app, route pattern, visibility and LoAF long frames; a visible tab silent ≥5 s becomes a main-thread-stall report plus a slow-op span (recovered 1–5 s long frames: slow-op only). In-tab fallback without SharedWorker. Slow interactions: Event Timing (input → next paint) per click / key press, its target resolved at dispatch (element, contribution, pane, component), its time split by the long frames inside it; ≥200 ms is an `interaction` slow-op, severe (≥800 ms) or recurring (3× ≥300 ms) a slow-interaction report, and it owns the 1–5 s long frame it caused.",
  contributions: [
    Core.Root({ component: MainThreadStallController, scope: "page" }),
    Reports.KindView({
      match: "main-thread-stall",
      component: MainThreadStallKindView,
    }),
    Reports.KindView({
      match: "slow-interaction",
      component: SlowInteractionKindView,
    }),
  ],
} satisfies PluginDefinition;
