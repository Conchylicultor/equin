import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { AppUsageRecorder } from "./components/app-usage-recorder";

export { useAppUsageSummary } from "./internal/use-app-usage-summary";

export default {
  description:
    "Records per-app usage from the browser — a launch whenever the focused app changes to another, active time while the app is focused, the page visible, the window focused and the user not idle for 5 minutes — and reads it back with useAppUsageSummary().",
  contributions: [Core.Root({ component: AppUsageRecorder, scope: "page" })],
} satisfies PluginDefinition;
