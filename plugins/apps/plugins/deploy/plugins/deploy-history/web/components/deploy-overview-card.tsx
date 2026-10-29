import type { ReactNode } from "react";
import {
  SITE_CARD_LIST_TOOLBAR,
  SiteCard,
  SiteCardBody,
  useSiteTabLink,
  type SiteProps,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import {
  deployRunHistory,
  type DeployRunRecord,
} from "@plugins/apps/plugins/deploy/plugins/deployments/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import {
  combineResources,
  foldResource,
  type ResourceReadiness,
} from "@plugins/primitives/plugins/live-state/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const OVERVIEW_VIEW = defineDataView("deploy.deployment.overview-runs");

const chevronIcon = symbol("chevron-right");

/** How many runs the Overview shows. */
const NEWEST = 4;

const STATUS_DOT: Record<DeployRunRecord["status"], string> = {
  running: "bg-primary animate-pulse",
  succeeded: "bg-success",
  failed: "bg-destructive",
  "needs-approval": "bg-warning",
};

/** What a run without a commit subject is called: its outcome, in words. */
function outcomeLabel(run: DeployRunRecord): string {
  switch (run.status) {
    case "running":
      return `Running ${run.verb}`;
    case "succeeded":
      return `Succeeded (${run.verb})`;
    case "needs-approval":
      return "Waiting for approval";
    case "failed":
      return run.phaseFailed ? `Failed on ${run.phaseFailed}` : "Failed";
  }
}

const FIELDS: FieldDef<DeployRunRecord>[] = [
  {
    id: "subject",
    label: "Run",
    type: "text",
    primary: true,
    value: (r) => r.commitSubject ?? outcomeLabel(r),
  },
  {
    id: "startedAt",
    label: "Started",
    type: "date",
    value: (r) => r.startedAt,
  },
];

function AllLink(): ReactNode {
  const link = useSiteTabLink("deployments");
  return (
    <Button variant="ghost" {...linkProps(link)}>
      All
      <Icon icon={chevronIcon} />
    </Button>
  );
}

const NO_RUNS: readonly DeployRunRecord[] = [];

/**
 * **Deployments** (Overview) — the newest four runs of this site's ledger,
 * with the one now live marked "current". Both reads are the ones the
 * production strip already makes (newest run; newest succeeded ship), so the
 * card adds one small window and no new question.
 */
export function DeployOverviewCard({ deployment }: SiteProps): ReactNode {
  const newest = useLive(deployRunHistory, {
    where: { deploymentId: deployment.id },
    orderBy: [["startedAt", "desc"]],
    limit: NEWEST,
  });
  // The newest succeeded shipping run — what is live now (RemoteDeploy's
  // DeployedCell reads the same window).
  const live = useLive(deployRunHistory, {
    where: {
      deploymentId: deployment.id,
      status: "succeeded",
      verb: { in: ["ship", "update"] },
    },
    orderBy: [["startedAt", "desc"]],
    limit: 1,
  });
  const reads = combineResources({ newest, live });
  return (
    <SiteCard title="Deployments" trailing={<AllLink />}>
      <SiteCardBody>
        {/* `readiness` carries loading and failure; the rows below are only
            read once both windows are ready. */}
        {foldResource(reads, {
          loading: () => (
            <RunList reads={reads} runs={NO_RUNS} currentId={null} />
          ),
          error: () => (
            <RunList reads={reads} runs={NO_RUNS} currentId={null} />
          ),
          ready: (d) => (
            <RunList
              reads={reads}
              runs={d.newest}
              currentId={d.live[0]?.id ?? null}
            />
          ),
        })}
      </SiteCardBody>
    </SiteCard>
  );
}

function RunList({
  reads,
  runs,
  currentId,
}: {
  reads: ResourceReadiness;
  runs: readonly DeployRunRecord[];
  currentId: string | null;
}): ReactNode {
  const link = useSiteTabLink("deployments");
  return (
    <DataView<DeployRunRecord>
      rows={runs}
      readiness={reads}
      fields={FIELDS}
      rowKey={(r) => r.id}
      views={["list"]}
      defaultView="list"
      density="compact"
      toolbar={SITE_CARD_LIST_TOOLBAR}
      storageKey={OVERVIEW_VIEW}
      rowActivation={() => link}
      viewOptions={{
        list: {
          renderRow: (r: DeployRunRecord) => (
            <RunLine run={r} current={r.id === currentId} />
          ),
        },
      }}
      emptyState={<>Nothing has been deployed from here yet.</>}
    />
  );
}

function RunLine({
  run,
  current,
}: {
  run: DeployRunRecord;
  current: boolean;
}): ReactNode {
  return (
    <Fill>
      {/* Row, centred: the dot sits beside the two lines, not on the last. */}
      <Stack direction="row" align="center" gap="sm">
        <StatusDot colorClass={STATUS_DOT[run.status]} />
        <Fill>
          <Stack gap="2xs">
            <Line>
              <Text variant="label">
                {run.commitSubject ?? outcomeLabel(run)}
              </Text>
            </Line>
            <Line>
              {run.commitSha && (
                <Badge variant="muted" mono tooltip={run.commitSha}>
                  {run.commitSha.slice(0, 7)}
                </Badge>
              )}
              <Text as="span" variant="caption" tone="muted">
                <RelativeTime date={run.startedAt} />
                {current ? " · current" : ""}
              </Text>
            </Line>
          </Stack>
        </Fill>
      </Stack>
    </Fill>
  );
}
