import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { Reports } from "@plugins/reports/web";
import { CrashCollector } from "./components/crash-collector";
import { CrashSummary } from "./components/crash-summary";

export default {
  collapsed: true,
  description:
    "Crash report kind: browser crash collector and the Debug → Reports summary view.",
  contributions: [
    Core.Root({ component: CrashCollector, scope: "page" }),
    Reports.KindView({ match: "crash", component: CrashSummary }),
  ],
} satisfies PluginDefinition;
