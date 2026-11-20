import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { deploymentAnalyticsServed } from "./internal/served";
import { deploymentPulseServed } from "./internal/pulse-served";

export default {
  description:
    "Serves a deployment's analytics report: collect's own runAnalyticsQuery run on this computer's copy of the site's analytics tables (site-mirror's readSiteMirror, as of the box's clock at the last page synced), pushed on each page the copy applies — report, refused, or not-copied while no whole first copy is in place (rendered as loading); and its pulse (deploy-analytics.pulse: visitors now, today and the last hour per minute, collect's readVisitorPulse on the same copy, as of the same clock).",
  contributions: [
    ...deploymentAnalyticsServed.declare,
    ...deploymentPulseServed.declare,
  ],
} satisfies ServerPluginDefinition;
