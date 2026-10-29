import { useMemo } from "react";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  mapResource,
  type ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import { deployRuns, type DeployRun } from "../../core";

/**
 * Where a site stands, from its most recent run alone:
 *
 * - `live` — the last run succeeded;
 * - `deploying` — a run is in flight;
 * - `failed` — the last run failed;
 * - `needs-approval` — the last run is held on an approval (a secret);
 * - `pending` — no run at all: never deployed from here.
 *
 * "Behind main" is deliberately not a status: it is release knowledge, owned by
 * the release pipeline's own surfaces, so the site host stays free of it.
 */
export const SITE_STATUSES = [
  "live",
  "deploying",
  "failed",
  "needs-approval",
  "pending",
] as const;
export type SiteStatus = (typeof SITE_STATUSES)[number];

/** The one fold of a run into a {@link SiteStatus} — private: every surface
 *  reads it through {@link useSiteStatuses} / {@link useSiteStatus}, so no
 *  list folds the run map its own way. */
function siteStatusOf(run: Pick<DeployRun, "status"> | undefined): SiteStatus {
  switch (run?.status) {
    case undefined:
      return "pending";
    case "running":
      return "deploying";
    case "succeeded":
      return "live";
    case "failed":
      return "failed";
    case "needs-approval":
      return "needs-approval";
  }
}

/** Every site's status, by deployment id. */
export type SiteStatusOf = (deploymentId: string) => SiteStatus;

/**
 * Every site's status at once, from ONE read — the whole `deployRuns` map
 * (each deployment's most recent run). For a list: the sites index, the
 * sidebar, a server's sites — no read per row.
 *
 * The map is complete across a restart: the server seeds it at boot with
 * every deployment's newest ledger row (`seedNewestRuns`,
 * `server/internal/run-state.ts`), so a site deployed before this boot reads
 * `live`, not `pending`. `loading` until the map lands — never `pending`
 * meanwhile ("never deployed" is a claim the read has not made yet).
 */
export function useSiteStatuses(): ResourceResult<SiteStatusOf> {
  const runs = useLive(deployRuns);
  return useMemo(
    () => mapResource(runs, (r) => (id: string) => siteStatusOf(r[id])),
    [runs],
  );
}

/** One site's status — {@link useSiteStatuses}, read for one id. */
export function useSiteStatus(
  deploymentId: string,
): ResourceResult<SiteStatus> {
  const statuses = useSiteStatuses();
  return useMemo(
    () => mapResource(statuses, (of) => of(deploymentId)),
    [statuses, deploymentId],
  );
}
