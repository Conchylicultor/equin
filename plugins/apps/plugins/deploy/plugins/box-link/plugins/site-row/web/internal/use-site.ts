import {
  mapResource,
  type ResourceResult,
} from "@plugins/network/plugins/live/plugins/live-state/web";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  siteHealth,
  type SiteHealth,
} from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/core";

/**
 * Every deployed site's health — the row set's ONE read
 * (`deploy.site-health`). `unavailable` under a host without the computer.
 */
export function useSites() {
  return useLive(siteHealth);
}

/**
 * One site's health, off the same read: the per-item parts of the row set ask
 * for their own item (a shared tuple, so no second subscription). `undefined`
 * once ready means the site is gone — its row is about to vanish with it.
 */
export function useSite(
  deploymentId: string,
):
  | ResourceResult<SiteHealth | undefined>
  | { status: "unavailable"; message: string } {
  const sites = useSites();
  if (sites.status === "unavailable") return sites;
  return mapResource(sites, (all) => all[deploymentId]);
}
