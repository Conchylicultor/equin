import type { ReactNode } from "react";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type {
  SetItemProps,
  SetRows,
} from "@plugins/shell/plugins/health-report/web";
import type { SiteHealth } from "@plugins/apps/plugins/deploy/plugins/box-link/plugins/link/core";
import { SiteLive, type SiteExhibitState, type SiteLivePart } from "../slots";
import { siteAlert, siteStatus, siteTitle } from "../internal/status";
import { useSite, useSites } from "../internal/use-site";

/**
 * The row set's one read: every deployed site as an item — keyed by
 * deployment, named by its hostname, its state from `siteStatus`. Not known
 * yet is `pending`; a host without the computer has no deployed sites to
 * report (`ready` with none — the set draws nothing).
 */
export function useSiteRows(): SetRows {
  const sites = useSites();
  switch (sites.status) {
    case "loading":
      return { kind: "pending" };
    case "error":
      return { kind: "error", summary: sites.error.message };
    case "unavailable":
      return { kind: "ready", rows: [] };
    case "ready":
      return {
        kind: "ready",
        rows: Object.values(sites.data)
          .sort((a, b) => siteTitle(a).localeCompare(siteTitle(b)))
          .map((site) => ({
            key: site.deploymentId,
            title: siteTitle(site),
            status: siteStatus(site),
          })),
      };
  }
}

/**
 * Renders one slot's parts for a site: the live part, or — in an exhibit —
 * the part's own drawing of the state (its `component` on the fixture site
 * when it declares none).
 */
function renderPart(
  part: SiteLivePart,
  site: SiteHealth,
  exhibit: SiteExhibitState | undefined,
): ReactNode {
  const props = { deploymentId: site.deploymentId, site };
  if (exhibit !== undefined && part.exhibit !== undefined) {
    return <part.exhibit {...props} state={exhibit} />;
  }
  return <part.component {...props} />;
}

/** The figure at the end of the title line — `SiteLive.Glance`, right-aligned. */
export function SiteGlanceView({
  site,
  exhibit,
}: {
  site: SiteHealth;
  exhibit?: SiteExhibitState;
}) {
  return (
    <Inline gap="sm">
      <SiteLive.Glance.Render>
        {(part) => renderPart(part, site, exhibit)}
      </SiteLive.Glance.Render>
    </Inline>
  );
}

/** What is wrong, in one sentence: the first line of the row's body. */
export function SiteAlertView({ site }: { site: SiteHealth }) {
  const alert = siteAlert(site);
  if (alert === null) return null;
  return (
    <Text
      variant="caption"
      className={cn(
        alert.tone === "critical" ? "text-destructive" : "text-warning",
      )}
    >
      {alert.lead}
      {alert.rest !== undefined ? (
        <span className="text-muted-foreground">{` · ${alert.rest}`}</span>
      ) : null}
    </Text>
  );
}

/**
 * The row's body: what is wrong (the alert), every `SiteLive.Section` top to
 * bottom, then the footer —
 * every `SiteLive.Action` left to right over a hairline, hidden while no
 * action has anything to offer this site.
 */
export function SiteBodyView({
  site,
  exhibit,
}: {
  site: SiteHealth;
  exhibit?: SiteExhibitState;
}) {
  return (
    // A part with nothing to say leaves an empty cell: hidden, so it takes no gap.
    <Stack gap="sm" className="[&>:empty]:hidden">
      <SiteAlertView site={site} />
      <SiteLive.Section.Render>
        {(part) => renderPart(part, site, exhibit)}
      </SiteLive.Section.Render>
      {/* The footer hides itself while no action drew a control. */}
      <Inline
        gap="xs"
        className="border-t pt-sm [&:not(:has(button,a))]:hidden [&>:empty]:hidden"
      >
        <SiteLive.Action.Render>
          {(part) => renderPart(part, site, exhibit)}
        </SiteLive.Action.Render>
      </Inline>
    </Stack>
  );
}

/** `useSite`'s answer, as the item's parts draw it: only a known site draws. */
function KnownSite({
  rowKey,
  children,
}: {
  rowKey: string;
  children: (site: SiteHealth) => ReactNode;
}) {
  const site = useSite(rowKey);
  switch (site.status) {
    case "ready":
      // Gone: the moment it leaves the set, its row with it.
      return site.data === undefined ? null : children(site.data);
    // The set lists only a site this same (shared) read holds, so an item is
    // never drawn before it is ready; a failed or unavailable read already
    // drew the set's own placeholder line instead of its items.
    case "loading":
    case "error":
    case "unavailable":
      return null;
  }
}

/** The set's `actions`: the glance figure, per site. */
export function SiteGlance({ rowKey }: SetItemProps) {
  return (
    <KnownSite rowKey={rowKey}>
      {(site) => <SiteGlanceView site={site} />}
    </KnownSite>
  );
}

/** The set's `component`: the body, per site. */
export function SiteDetail({ rowKey }: SetItemProps) {
  return (
    <KnownSite rowKey={rowKey}>
      {(site) => <SiteBodyView site={site} />}
    </KnownSite>
  );
}
