import {
  Core,
  type PluginDefinition,
} from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { MainThreadStallController } from "./components/main-thread-stall-controller";
import { MainThreadStallKindView } from "./components/main-thread-stall-kind-view";

export default {
  description:
    "Main-thread stall detector: a Core.Root controller that attaches each tab to one out-of-thread SharedWorker watchdog (1 Hz ping, Web Lock per tab, IndexedDB record of an open stall) and feeds it the tab's app, route pattern, visibility and LoAF long frames; a visible tab silent ≥5 s becomes a main-thread-stall report plus a slow-op span (recovered 1–5 s long frames: slow-op only). In-tab fallback without SharedWorker.",
  contributions: [
    Core.Root({ component: MainThreadStallController }),
    Reports.KindView({
      match: "main-thread-stall",
      component: MainThreadStallKindView,
    }),
  ],
} satisfies PluginDefinition;
