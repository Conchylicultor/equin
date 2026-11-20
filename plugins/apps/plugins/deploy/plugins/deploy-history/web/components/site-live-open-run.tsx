import type { ReactNode } from "react";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { sitePane } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { deployApp } from "@plugins/apps/plugins/deploy/plugins/shell/core";
import type { SiteLiveProps } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/site-row/web";

/**
 * Open run, in the health report's site row: while a deploy runs or after
 * one failed, the site's Deployments tab — the run's record, its message and
 * (while it runs) the live log.
 */
export function SiteOpenRunAction({
  deploymentId,
  site,
}: SiteLiveProps): ReactNode {
  const appLinkProps = useAppLinkProps();
  const status = site.run?.status;
  if (status !== "running" && status !== "failed") return null;
  return (
    <Button
      variant="ghost"
      {...appLinkProps(
        sitePane.link(deployApp, { deploymentId, tab: "deployments" }),
      )}
    >
      Open run
    </Button>
  );
}
