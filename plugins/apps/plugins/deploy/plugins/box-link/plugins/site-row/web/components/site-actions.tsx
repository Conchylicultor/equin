import type { ReactNode } from "react";
import { useEndpointMutation } from "@plugins/infra/plugins/endpoints/web";
import { NewTabButton } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { boxLinkRetryEndpoint } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/core";
import type { SiteLiveProps } from "../slots";

/**
 * Retry now — the link's own action: offered while the link is not live
 * (reconnecting, down, unreachable, refused, outdated), it reopens the
 * tunnel and reconnects the stream at once instead of waiting out the
 * backoff. The link's state says how it went.
 */
export function RetryAction({ deploymentId, site }: SiteLiveProps): ReactNode {
  const retry = useEndpointMutation(boxLinkRetryEndpoint);
  // A link is held only where the computer is: no link here, nothing to retry.
  if (site.link.kind !== "linked" || retry.kind === "unavailable") return null;
  switch (site.link.link.state.kind) {
    case "connecting":
    case "live":
      return null;
    case "reconnecting":
    case "down":
    case "unreachable":
    case "refused":
    case "outdated":
      return (
        <Button
          variant="ghost"
          loading={retry.isPending}
          onClick={() => retry.mutate({ params: { deploymentId } })}
        >
          Retry now
        </Button>
      );
  }
}

/**
 * Open site — the public address, offered while the site is simply up: live
 * (or linked from main), not deploying, its last deploy not failed, nothing
 * behind main. In any other state another action is what to do next.
 */
export function OpenSiteAction({ site }: SiteLiveProps): ReactNode {
  if (site.hostname === null) return null;
  const linkUp =
    site.link.kind === "main-only" || site.link.link.state.kind === "live";
  const settled =
    site.run === null ||
    (site.run.status !== "running" && site.run.status !== "failed");
  const current =
    site.release.kind === "known" && site.release.behindMain === 0;
  if (!linkUp || !settled || !current) return null;
  return (
    <NewTabButton href={`https://${site.hostname}`} variant="ghost">
      Open site
    </NewTabButton>
  );
}
