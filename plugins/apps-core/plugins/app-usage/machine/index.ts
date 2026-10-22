import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { appUsageRetention } from "./internal/retention";

export default {
  description:
    "Per-app usage stats, desktop-only half: the two-year retention sweep of app_usage_daily (a nightly job on main's backend).",
  register: [appUsageRetention],
} satisfies MachinePluginDefinition;
