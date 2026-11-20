import type { ResourceResult } from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { deploymentPulse, type DeploymentPulse } from "../../core";

/**
 * A deployment's pulse, live (`deploy-analytics.pulse`): loading, an error
 * (`missing` once the deployment is deleted), or ready with `pulse` (visitors
 * now, today, the last hour per minute, `asOf` the site's clock at the last
 * page synced) or `not-copied` — no whole first copy in place yet, a pending
 * state to render as loading, never as zero visitors. Pushed on every page the
 * copy applies; no request of its own.
 */
export function useAnalyticsPulse(
  deploymentId: string,
): ResourceResult<DeploymentPulse, "missing"> {
  return useLive(deploymentPulse, { deploymentId });
}
