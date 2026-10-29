import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { ReactNode } from "react";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import type { Contribution } from "@plugins/framework/plugins/web-sdk/core";
import {
  renderIsolated,
  useSlotOrder,
} from "@plugins/primitives/plugins/slot-render/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Surface } from "@plugins/primitives/plugins/css/plugins/surface/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { NewTabLink } from "@plugins/primitives/plugins/link-gesture/plugins/new-tab/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { publicUrls, type Deployment } from "../../core";
import { useSiteStatus } from "../internal/site-status";
import { useSetSiteTab } from "../internal/site-tab";
import { sitePane } from "../panes";
import { SiteHeader, SiteStrip, SiteTabs } from "../slots";
import { SiteBannerHost } from "./site-banner";
import { SiteStatusPill } from "./site-status-dot";

const compositionIcon = symbol("deployed-code");

/** The name a person recognises a site by: its primary hostname, else its composition. */
export function siteName(deployment: Deployment): string {
  return deployment.hostnames[0] ?? deployment.compositionId;
}

/**
 * One site's page: the header (identity + contributed actions), the production
 * strip with the one banner that needs attention, then the tabs — the active
 * one is the URL's `:tab?`, switched in place.
 *
 * Every piece but the identity is a contribution (`SiteHeader`, `SiteStrip`,
 * `SiteBanner`, `SiteTabs`): this page names none of the plugins that fill it.
 */
export function SitePage({
  deployment,
}: {
  deployment: Deployment;
}): ReactNode {
  const { tab } = sitePane.useParams();
  const setTab = useSetSiteTab();
  return (
    <SiteTabs.Host
      deploymentId={deployment.id}
      activeId={tab}
      onActiveChange={setTab}
      className="mx-auto w-full max-w-[1180px] px-xl pb-2xl"
      header={
        <Stack gap="none">
          <SiteHeaderRow deployment={deployment} />
          <ProductionStrip deployment={deployment} />
        </Stack>
      }
    />
  );
}

function SiteHeaderRow({ deployment }: { deployment: Deployment }): ReactNode {
  return (
    <Inset t="xs" b="lg">
      <Stack direction="row" align="start" gap="md">
        <SiteMark name={siteName(deployment)} />
        <Fill>
          <Stack gap="2xs">
            <Inline gap="sm">
              <Text as="h1" variant="title">
                {siteName(deployment)}
              </Text>
              <HeaderStatus deploymentId={deployment.id} />
            </Inline>
            <HeaderMeta deployment={deployment} />
          </Stack>
        </Fill>
        <Inline gap="sm">
          <SiteHeader.Action.Render>
            {(part) => <part.component deployment={deployment} />}
          </SiteHeader.Action.Render>
        </Inline>
      </Stack>
    </Inset>
  );
}

/** The mark's tile per size: the page header's, and a card's slightly smaller. */
const MARK_SIZE = { md: "size-11", sm: "size-9.5" } as const;

/**
 * The site's mark: the first letter of its name on a small raised tile —
 * `md` on the site's page, `sm` on its card in the sites index.
 */
export function SiteMark({
  name,
  size = "md",
}: {
  name: string;
  size?: keyof typeof MARK_SIZE;
}): ReactNode {
  return (
    <Rigid>
      <Surface level="raised" className={cn(MARK_SIZE[size], "rounded-lg")}>
        <Center className="size-full">
          <Text as="span" variant="heading" tone="strong">
            {name.slice(0, 1).toLowerCase()}
          </Text>
        </Center>
      </Surface>
    </Rigid>
  );
}

function HeaderStatus({ deploymentId }: { deploymentId: string }): ReactNode {
  const status = useSiteStatus(deploymentId);
  switch (status.status) {
    case "loading":
      return <Loading />;
    case "error":
      return (
        <ResourceErrorInline
          variant="inline"
          subject="the site's status"
          error={status.error}
          refetch={status.refetch}
        />
      );
    case "ready":
      return <SiteStatusPill status={status.data} />;
  }
}

/** Hostnames as external links, then the composition it serves. */
function HeaderMeta({ deployment }: { deployment: Deployment }): ReactNode {
  const urls = publicUrls(deployment.hostnames);
  return (
    <Cluster gap="md">
      {urls.map((url, i) => (
        <NewTabLink
          key={url}
          href={url}
          className="text-muted-foreground hover:text-foreground"
        >
          <Text as="span" variant="caption">
            {deployment.hostnames[i]}
          </Text>
        </NewTabLink>
      ))}
      {urls.length > 0 && (
        <Text as="span" variant="caption" tone="faint">
          ·
        </Text>
      )}
      <Inline gap="2xs" className="text-muted-foreground">
        <Icon icon={compositionIcon} />
        <Text as="span" variant="caption">
          {deployment.compositionId}
        </Text>
      </Inline>
    </Cluster>
  );
}

/**
 * The production strip: what is live, one cell per contribution, then the
 * banner (if any) under a hairline — one card, always visible.
 */
function ProductionStrip({
  deployment,
}: {
  deployment: Deployment;
}): ReactNode {
  return (
    <Surface level="raised">
      <StripCells deployment={deployment} />
      <SiteBannerHost deployment={deployment} />
    </Surface>
  );
}

/**
 * The cells, in the slot's layout order, drawn by this host: each a caption over
 * its contributed value, divided by hairlines. Until the order is known the
 * strip keeps its height with a loading row (never the raw registration order).
 */
function StripCells({ deployment }: { deployment: Deployment }): ReactNode {
  const order = useSlotOrder(SiteStrip.Cell);
  const cells = foldResource(order, {
    loading: () => null,
    error: (_error, stale) => stale ?? null,
    ready: (list) => list,
  });
  if (cells === null) {
    return order.status === "error" ? (
      <ResourceErrorInline
        variant="block"
        subject="the production strip"
        error={order.error}
        refetch={order.refetch}
      />
    ) : (
      <Inset x="md" y="sm">
        <Loading variant="rows" count={1} />
      </Inset>
    );
  }
  return (
    <Grid
      minCellWidth="9rem"
      mode="fit"
      gap="none"
      className="divide-x divide-border/60"
    >
      {cells.map((cell) => (
        <Inset key={cell.id} x="md" y="sm">
          <Stack gap="2xs">
            <Text as="span" variant="caption" tone="faint">
              {cell.label}
            </Text>
            <Line className="gap-xs">
              {renderIsolated(SiteStrip.Cell, cell as unknown as Contribution, {
                deployment,
              })}
            </Line>
          </Stack>
        </Inset>
      ))}
    </Grid>
  );
}
