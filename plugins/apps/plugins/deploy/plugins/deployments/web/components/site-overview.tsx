import type { ReactNode } from "react";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import { useLiveRow } from "@plugins/network/plugins/live/web";
import { Center } from "@plugins/primitives/plugins/css/plugins/center/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Button,
  ControlSizeProvider,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  renderAsContribution,
  useSlotOrder,
} from "@plugins/primitives/plugins/slot-render/web";
import { symbol, type IconRef } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { deployments, type Deployment } from "../../core";
import {
  SiteCheck,
  SiteOverview,
  type SiteCheckContribution,
  type SiteCheckResult,
  type SiteCheckState,
  type SiteOverviewColumn,
} from "../slots";
import { SiteCard } from "./site-card";

/**
 * The Overview tab: a wide `main` column and a 340px `side` rail of
 * `SiteOverview.Card` contributions, in slot order, with this plugin's own
 * Checks card closing the rail. The host owns the placement only — each card
 * paints its own `SiteCard`.
 */
export function SiteOverviewTab({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  const row = useLiveRow(deployments, deploymentId);
  if (row.status === "loading") return <Loading variant="rows" />;
  if (row.status === "error") {
    return (
      <ResourceErrorInline
        variant="block"
        subject="the site"
        error={row.error}
        refetch={row.refetch}
      />
    );
  }
  if (!row.found) {
    return <Placeholder tone="error">This site no longer exists.</Placeholder>;
  }
  return <OverviewGrid deployment={row.row} />;
}

function OverviewGrid({ deployment }: { deployment: Deployment }): ReactNode {
  return (
    <Stack direction="row" align="start" gap="md" wrap>
      <Fill className="min-w-[min(100%,28rem)]">
        <OverviewColumn column="main" deployment={deployment} />
      </Fill>
      <Rigid className="w-[340px] max-w-full">
        <Stack gap="md">
          <OverviewColumn column="side" deployment={deployment} />
          <ChecksCard deployment={deployment} />
        </Stack>
      </Rigid>
    </Stack>
  );
}

function OverviewColumn({
  column,
  deployment,
}: {
  column: SiteOverviewColumn;
  deployment: Deployment;
}): ReactNode {
  return (
    <Stack gap="md">
      <SiteOverview.Card.Render subId={column}>
        {(card) =>
          card.column === column ? (
            <card.component deployment={deployment} />
          ) : null
        }
      </SiteOverview.Card.Render>
    </Stack>
  );
}

const CHECK_ICON: Record<SiteCheckState, { icon: IconRef; tint: string }> = {
  ok: { icon: symbol("check"), tint: "bg-success/15 text-success" },
  warn: { icon: symbol("warning"), tint: "bg-warning/15 text-warning" },
  fail: { icon: symbol("close"), tint: "bg-destructive/15 text-destructive" },
  pending: {
    icon: symbol("more-horiz"),
    tint: "bg-muted text-muted-foreground",
  },
};

/**
 * Checks: one row per `SiteCheck` contribution that applies to this site.
 * Absent when nothing contributes a check.
 */
function ChecksCard({ deployment }: { deployment: Deployment }): ReactNode {
  const order = useSlotOrder(SiteCheck);
  const checks = foldResource(order, {
    loading: (): readonly SealContributions<SiteCheckContribution>[] | null =>
      null,
    error: (_error, stale) => stale ?? null,
    ready: (list) => list,
  });
  if (checks === null) {
    return (
      <SiteCard title="Checks">
        {order.status === "error" ? (
          <ResourceErrorInline
            variant="block"
            subject="the checks"
            error={order.error}
            refetch={order.refetch}
          />
        ) : (
          <Inset pad="md">
            <Loading variant="rows" count={3} />
          </Inset>
        )}
      </SiteCard>
    );
  }
  if (checks.length === 0) return null;
  return (
    <SiteCard title="Checks">
      <Stack gap="none" className="divide-y divide-border/60">
        {checks.map((check) => (
          <CheckRow
            key={check.id}
            check={check}
            useCheck={check.useCheck}
            deployment={deployment}
          />
        ))}
      </Stack>
    </SiteCard>
  );
}

function CheckRow({
  check,
  useCheck,
  deployment,
}: {
  check: object;
  useCheck: SiteCheckContribution["useCheck"];
  deployment: Deployment;
}): ReactNode {
  const result = useCheck({ deployment });
  if (result === null) return null;
  return renderAsContribution(SiteCheck, check, <CheckView result={result} />);
}

function CheckView({ result }: { result: SiteCheckResult }): ReactNode {
  const look = CHECK_ICON[result.state];
  return (
    <Inset x="md" y="sm">
      <Stack direction="row" align="center" gap="sm">
        <Rigid className={`size-5 rounded-md ${look.tint}`}>
          <Center className="size-full">
            <Icon icon={look.icon} />
          </Center>
        </Rigid>
        <Fill>
          <Stack gap="none">
            <Text variant="label">{result.label}</Text>
            <Text variant="caption" tone="muted">
              {result.detail}
            </Text>
          </Stack>
        </Fill>
        {result.fix && result.state !== "ok" && (
          <ControlSizeProvider size="sm">
            <Button variant="outline" {...linkProps(result.fix)}>
              Fix
            </Button>
          </ControlSizeProvider>
        )}
      </Stack>
    </Inset>
  );
}
