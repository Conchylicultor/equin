import { Core, type PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { CollabHydrationCollector } from "./components/collab-hydration-collector";
import { CollabHydrationKindView } from "./components/collab-hydration-kind-view";

export default {
  description:
    "Collab-hydration collector: drains the page editor's collabHydrationReportSink into a report whenever a block's rendered text stops agreeing with its content doc (a binding that never hydrated) or with the server (a doc that never received its push), plus the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: CollabHydrationCollector, scope: "page" }),
    Reports.KindView({ match: "collab-hydration", component: CollabHydrationKindView }),
  ],
} satisfies PluginDefinition;
