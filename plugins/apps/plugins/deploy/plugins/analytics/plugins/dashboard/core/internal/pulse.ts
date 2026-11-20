import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import { VisitorPulseSchema } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { NotCopiedSchema } from "./analytics";

/**
 * What asking a deployment for its pulse answered: `pulse` (collect's own
 * `VisitorPulse` — visitors now, today, the last hour per minute — computed on
 * this computer's copy of the site's analytics tables, as of the site's clock
 * at the last page synced), or `not-copied` while no whole first copy is in
 * place. Never a zero standing in for a copy that is not there.
 */
export const DeploymentPulseSchema = z.discriminatedUnion("kind", [
  VisitorPulseSchema.extend({ kind: z.literal("pulse") }),
  NotCopiedSchema,
]);
export type DeploymentPulse = z.infer<typeof DeploymentPulseSchema>;

/**
 * A deployment's pulse — the site row's Visitors section: collect's own
 * `readVisitorPulse` run on this computer's copy of the site's analytics
 * tables (site-mirror's `analytics` set) as of the copy's `sourceNow`, pushed
 * on every page the copy applies. A deployment that does not exist is
 * refused `missing`.
 */
export const deploymentPulse = liveValue("deploy-analytics.pulse", {
  schema: DeploymentPulseSchema,
  params: ["deploymentId"],
  refusals: ["missing"],
});
