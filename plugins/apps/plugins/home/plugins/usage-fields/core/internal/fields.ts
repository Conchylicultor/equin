import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { clientFields } from "@plugins/network/plugins/live/core";
import { installedApp } from "@plugins/apps-core/plugins/app-launcher/core";

/**
 * The usage stats of each installed app, as fields of every list of apps (the
 * Home grid's table view shows them as columns): opens and active time over 7
 * days and all time, and when the app was last opened. Their values are the
 * browser's read of `app-usage`'s summary (`ClientFields.Resolve` in this
 * plugin's web half).
 */
export const appUsageFields = clientFields(installedApp, "usage", {
  fields: {
    focusedMs7d: intField({ label: "Time · 7d" }),
    launches7d: intField({ label: "Opens · 7d" }),
    focusedMsTotal: intField({ label: "Time · all" }),
    launchesTotal: intField({ label: "Opens · all" }),
    lastOpenedAt: dateField({ label: "Last opened" }),
  },
});
