import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ClientFields } from "@plugins/network/plugins/live/web";
import { appUsageFields } from "../core";
import { UsageResolver } from "./internal/usage-resolver";
import { usagePresentation } from "./internal/presentation";

export default {
  description:
    "Declares per-app usage stats as client fields of the installed-app row kind: opens and active time over 7 days and all time, and when the app was last opened — sortable, filterable fields shown as columns of the Home grid's table view.",
  contributions: [
    ClientFields.Resolve({
      fields: appUsageFields,
      component: UsageResolver,
    }),
    usagePresentation,
  ],
} satisfies PluginDefinition;
