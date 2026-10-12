import type { ReactElement } from "react";
import {
  Pane,
  PaneChrome,
  defineRoute,
  resolveFrom,
  resolveRow,
  rowOrStale,
  useOpenPane,
  type ResolveResult,
} from "@plugins/primitives/plugins/pane/web";
import { useLive, useLiveRow } from "@plugins/network/plugins/live/web";
import { debugApp } from "@plugins/apps/plugins/debug/plugins/shell/core";
import { deadJobs } from "@plugins/infra/plugins/jobs/core";
import {
  eventEmissions,
  eventTriggers,
} from "@plugins/infra/plugins/events/core";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import {
  foldResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { Inset } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { queueRoute } from "../core";
import { QUEUE_TABS, TAB_META, parseTab, type QueueTab } from "./internal/tabs";
import { findJobRow, useJobRows } from "./internal/job-rows";
import { JobsView } from "./components/jobs-view";
import { DeadView } from "./components/dead-view";
import { EventsView } from "./components/events-view";
import { TriggersView } from "./components/triggers-view";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { JobDetail } from "./components/job-detail";
import {
  DeadJobDetail,
  EmissionDetail,
  TriggerDetail,
} from "./components/other-details";

export const queuePane = Pane.define({
  title: "Queue",
  route: queueRoute,
  app: debugApp,
  component: QueueBody,
  // `:tab?` is a view of the pane, not an entity: an unknown section opens the
  // default one (`parseTab`), so there is nothing to resolve.
  useResolve: false,
});

// Pane segment patterns are globally unique: each detail's `queue-…/` prefix
// names that pane alone.
const jobDetailRoute = defineRoute({
  id: "queue-job",
  segment: "queue-job/:jobRowId",
  parent: queueRoute,
});
const deadDetailRoute = defineRoute({
  id: "queue-dead",
  segment: "queue-dead/:deadId",
  parent: queueRoute,
});
const emissionDetailRoute = defineRoute({
  id: "queue-emission",
  segment: "queue-emission/:emissionId",
  parent: queueRoute,
});
const triggerDetailRoute = defineRoute({
  id: "queue-trigger",
  segment: "queue-trigger/:triggerId",
  parent: queueRoute,
});

// ─── The tab switcher (a header item of the queue pane) ────────────────────

const TAB_OPTIONS = QUEUE_TABS.map((id) => ({
  id,
  label: TAB_META[id].label,
  icon: <Icon icon={TAB_META[id].icon} className="size-4" />,
}));

/**
 * The section switcher, in the queue pane's header. Switching swaps the pane
 * in place — a fresh instance on the new `:tab?`, so a detail opened from the
 * previous section closes with it.
 */
export function QueueTabs(): ReactElement {
  const tab = parseTab(queuePane.useParams().tab);
  const openPane = useOpenPane();
  return (
    <SegmentedControl
      options={TAB_OPTIONS}
      value={tab}
      onChange={(next: QueueTab) =>
        openPane(queuePane, { tab: next }, { mode: "swap" })
      }
      variant="ghost"
      label="Queue section"
    />
  );
}

// ─── The list ──────────────────────────────────────────────────────────────

function QueueBody(): ReactElement {
  const tab = parseTab(queuePane.useParams().tab);
  return (
    <PaneChrome pane={queuePane}>
      <TabBody tab={tab} />
    </PaneChrome>
  );
}

function TabBody({ tab }: { tab: QueueTab }): ReactElement {
  const openPane = useOpenPane();
  const jobKey = jobDetailPane.useRouteEntry()?.params.jobRowId;
  const deadId = deadDetailPane.useRouteEntry()?.params.deadId;
  const emissionId = emissionDetailPane.useRouteEntry()?.params.emissionId;
  const triggerId = triggerDetailPane.useRouteEntry()?.params.triggerId;
  switch (tab) {
    case "jobs":
      return (
        <JobsView
          selectedKey={jobKey}
          linkTo={(jobRowId) =>
            openPane.to(jobDetailPane, { tab, jobRowId }, { mode: "push" })
          }
        />
      );
    case "dead":
      return (
        <DeadView
          selectedId={deadId}
          linkTo={(id) =>
            openPane.to(deadDetailPane, { tab, deadId: id }, { mode: "push" })
          }
        />
      );
    case "events":
      return (
        <EventsView
          selectedId={emissionId}
          linkTo={(id) =>
            openPane.to(
              emissionDetailPane,
              { tab, emissionId: id },
              { mode: "push" },
            )
          }
        />
      );
    case "triggers":
      return (
        <TriggersView
          selectedId={triggerId}
          linkTo={(id) =>
            openPane.to(
              triggerDetailPane,
              { tab, triggerId: id },
              { mode: "push" },
            )
          }
        />
      );
  }
}

// ─── Jobs detail ───────────────────────────────────────────────────────────

/**
 * Found while the key names a row of the merged Jobs list — or, for a queue
 * row that has since finished, the run it became (`findJobRow`), so an open
 * pane follows its job out of the queue instead of turning into Not Found.
 */
function useResolveJobRow({ jobRowId }: { jobRowId: string }): ResolveResult {
  return resolveFrom(
    useJobRows(),
    (data) => findJobRow(data.rows, jobRowId) !== null,
  );
}

function useJobRowTitle({
  jobRowId,
}: {
  jobRowId: string;
}): string | undefined {
  // The pane's fallback title stands while the read is loading or failed.
  return foldResource(useJobRows(), {
    loading: () => undefined,
    error: () => undefined,
    ready: (d) => findJobRow(d.rows, jobRowId)?.row.jobName,
  });
}

export const jobDetailPane = Pane.define({
  route: jobDetailRoute,
  app: debugApp,
  title: { useText: useJobRowTitle, fallback: "Job" },
  component: JobDetailBody,
  width: 520,
  useResolve: useResolveJobRow,
});

function JobDetailBody(): ReactElement {
  const { jobRowId } = jobDetailPane.useParams();
  const { tab } = queuePane.useParams();
  const openPane = useOpenPane();
  const result = useJobRows();
  return (
    <PaneChrome pane={jobDetailPane}>
      <Inset pad="md">
        {result.status === "loading" ? (
          <Loading />
        ) : result.status === "error" ? (
          <ResourceErrorInline
            variant="block"
            subject="the job queue"
            error={result.error}
            refetch={result.refetch}
          />
        ) : (
          <JobDetailContent
            rows={result.data.rows}
            jobRowId={jobRowId}
            runTarget={(key) =>
              openPane.to(
                jobDetailPane,
                { tab, jobRowId: key },
                { mode: "swap" },
              )
            }
          />
        )}
      </Inset>
    </PaneChrome>
  );
}

function JobDetailContent({
  rows,
  jobRowId,
  runTarget,
}: {
  rows: Parameters<typeof findJobRow>[0];
  jobRowId: string;
  runTarget: (key: string) => LinkTarget;
}): ReactElement {
  const found = findJobRow(rows, jobRowId);
  // The guard said the row exists; it can still vanish under a mounted pane
  // (a pending row cancelled, a run overwritten in its ring). Say so in place.
  if (found === null) {
    return <Text tone="muted">This job is no longer listed.</Text>;
  }
  const jobRows = rows.filter((r) => r.jobName === found.row.jobName);
  return (
    <JobDetail
      row={found.row}
      followed={found.followed}
      jobRows={jobRows}
      runTarget={runTarget}
    />
  );
}

// ─── Dead detail ───────────────────────────────────────────────────────────

function useResolveDeadJob({ deadId }: { deadId: string }): ResolveResult {
  return resolveRow(useLiveRow(deadJobs, deadId));
}

function useDeadJobTitle({ deadId }: { deadId: string }): string | undefined {
  const row = useLiveRow(deadJobs, deadId);
  return row.status === "ready" && row.found ? row.row.jobName : undefined;
}

export const deadDetailPane = Pane.define({
  route: deadDetailRoute,
  app: debugApp,
  title: { useText: useDeadJobTitle, fallback: "Dead job" },
  component: DeadDetailBody,
  width: 520,
  useResolve: useResolveDeadJob,
});

function DeadDetailBody(): ReactElement {
  const { deadId } = deadDetailPane.useParams();
  const job = rowOrStale(useLiveRow(deadJobs, deadId));
  return (
    <PaneChrome pane={deadDetailPane}>
      <Inset pad="md">
        {job !== undefined ? <DeadJobDetail job={job} /> : <Loading />}
      </Inset>
    </PaneChrome>
  );
}

// ─── Emission detail ───────────────────────────────────────────────────────

function useResolveEmission({
  emissionId,
}: {
  emissionId: string;
}): ResolveResult {
  return resolveRow(useLiveRow(eventEmissions, emissionId));
}

function useEmissionTitle({
  emissionId,
}: {
  emissionId: string;
}): string | undefined {
  const row = useLiveRow(eventEmissions, emissionId);
  return row.status === "ready" && row.found ? row.row.eventName : undefined;
}

export const emissionDetailPane = Pane.define({
  route: emissionDetailRoute,
  app: debugApp,
  title: { useText: useEmissionTitle, fallback: "Emission" },
  component: EmissionDetailBody,
  width: 520,
  useResolve: useResolveEmission,
});

function EmissionDetailBody(): ReactElement {
  const { emissionId } = emissionDetailPane.useParams();
  const emission = rowOrStale(useLiveRow(eventEmissions, emissionId));
  const triggers = useLive(eventTriggers);
  return (
    <PaneChrome pane={emissionDetailPane}>
      <Inset pad="md">
        {emission !== undefined ? (
          <EmissionDetail
            emission={emission}
            triggers={foldResource(triggers, {
              // Unnamed until the triggers are read: the ids show bare.
              loading: () => null,
              error: (_e, stale) => stale ?? null,
              ready: (rows) => rows,
            })}
          />
        ) : (
          <Loading />
        )}
      </Inset>
    </PaneChrome>
  );
}

// ─── Trigger detail ────────────────────────────────────────────────────────

function useResolveTrigger({
  triggerId,
}: {
  triggerId: string;
}): ResolveResult {
  return resolveFrom(useLive(eventTriggers), (rows) =>
    rows.some((t) => t.id === triggerId),
  );
}

function useTriggerTitle({
  triggerId,
}: {
  triggerId: string;
}): string | undefined {
  return foldResource(useLive(eventTriggers), {
    loading: () => undefined,
    error: (_e, stale) => stale?.find((t) => t.id === triggerId)?.eventName,
    ready: (rows) => rows.find((t) => t.id === triggerId)?.eventName,
  });
}

export const triggerDetailPane = Pane.define({
  route: triggerDetailRoute,
  app: debugApp,
  title: { useText: useTriggerTitle, fallback: "Trigger" },
  component: TriggerDetailBody,
  width: 520,
  useResolve: useResolveTrigger,
});

function TriggerDetailBody(): ReactElement {
  const { triggerId } = triggerDetailPane.useParams();
  const result = useLive(eventTriggers);
  // The resolve guard answered "does this trigger exist"; a failed re-read
  // keeps it as last seen.
  const trigger = foldResource(result, {
    loading: () => undefined,
    error: (_e, stale) => stale?.find((t) => t.id === triggerId),
    ready: (rows) => rows.find((t) => t.id === triggerId),
  });
  return (
    <PaneChrome pane={triggerDetailPane}>
      <Inset pad="md">
        {trigger !== undefined ? (
          <TriggerDetail trigger={trigger} />
        ) : (
          <Loading />
        )}
      </Inset>
    </PaneChrome>
  );
}
