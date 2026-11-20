import type { ReactNode } from "react";
import { useAppLinkProps } from "@plugins/apps-core/plugins/tabs/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { SiteLiveAside } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/site-row/web";
import type { SiteVisitorsNoteProps } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/dashboard/web";
import type { SiteExhibitState } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/site-row/web";
import { sitePane } from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { deployApp } from "@plugins/apps/plugins/deploy/plugins/shell/core";
import { useNewMessagesCount } from "../internal/use-new-messages";

/** " · 2 new messages", a link into the site's Messages tab. */
function NewMessagesLink({
  deploymentId,
  count,
}: {
  deploymentId: string;
  count: number;
}): ReactNode {
  const appLinkProps = useAppLinkProps();
  return (
    <SiteLiveAside>
      {" · "}
      <Button
        variant="link"
        aspect="inline"
        {...appLinkProps(
          sitePane.link(deployApp, { deploymentId, tab: "messages" }),
        )}
      >
        {/* One run of text: the button lays its children out as flex items,
            which would drop the space between two of them. */}
        <span>
          <span className="font-semibold">{count}</span>
          {` new message${count === 1 ? "" : "s"}`}
        </span>
      </Button>
    </SiteLiveAside>
  );
}

/**
 * The Visitors block's "N new messages" note (`SiteVisitors.Note`): messages
 * received since the Messages tab was last opened, linking there. Says
 * nothing when there are none, while the link is stale (the row shows what
 * it last heard), or while the count is not known — the tab's own badge and
 * freshness line say why.
 */
export function NewMessagesNote({
  deploymentId,
  stale,
}: SiteVisitorsNoteProps): ReactNode {
  const fresh = useNewMessagesCount(deploymentId);
  if (stale) return null;
  switch (fresh.kind) {
    case "ready":
      return fresh.count > 0 ? (
        <NewMessagesLink deploymentId={deploymentId} count={fresh.count} />
      ) : null;
    case "loading":
    case "error":
    case "no-intake":
    case "not-copied":
      return null;
  }
}

/** The note in an exhibit state: two new messages, unless the link is stale. */
export function NewMessagesNoteExhibit({
  deploymentId,
  stale,
}: SiteVisitorsNoteProps & { state: SiteExhibitState }): ReactNode {
  return stale ? null : (
    <NewMessagesLink deploymentId={deploymentId} count={2} />
  );
}
