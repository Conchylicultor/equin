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
import { deadJobs, jobRuns, jobs } from "@plugins/infra/plugins/jobs/core";
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
import { fromLive, fromRun, parseJobKey } from "./internal/job-rows";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { useNow } from "@plugins/primitives/plugins/relative-time/web";
import { HistoryView, QueueView } from "./components/jobs-view";
import { DeadView } from "./components/dead-view";
import { EventsView } from "./components/events-view";
import { TriggersView } from "./components/triggers-view";
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
        <QueueView
          selectedKey={jobKey}
          linkTo={(jobRowId) =>
            openPane.to(jobDetailPane, { tab, jobRowId }, { mode: "push" })
          }
        />
      );
    case "history":
      return (
        <HistoryView
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

// A detail key names a queue row (`live:<graphile id>`, a `jobs` row) or a
// recorded run (`run:<run id>`, a `jobRuns` row). A queue row whose job has
// since finished is followed to the run it became — the newest run carrying
// its graphile id — so an open pane follows its job out of the queue instead
// of turning into Not Found.

/**
 * Found while the key names a queue row or a run — or, for a queue row that
 * has since left the queue, while a recorded run carries its graphile id (a
 * `:count` of them; the body reads the run itself).
 */
function useResolveJobRow({ jobRowId }: { jobRowId: string }): ResolveResult {
  const key = parseJobKey(jobRowId);
  const liveId = key?.kind === "live" ? key.id : null;
  const queueRow = useLiveRow(jobs, liveId);
  const run = useLiveRow(jobRuns, key?.kind === "run" ? key.id : null);
  const followed = useLive(
    liveId === null ? null : jobRuns,
    liveId === null ? null : { count: true, where: { jobId: liveId } },
  );
  if (key === null) return { status: "missing" };
  if (key.kind === "run") return resolveRow(run);
  const inQueue = resolveRow(queueRow);
  if (inQueue.status !== "missing") return inQueue;
  return resolveFrom(followed, (n) => n > 0);
}

function useJobRowTitle({
  jobRowId,
}: {
  jobRowId: string;
}): string | undefined {
  // The pane's fallback title stands while a read is loading or failed, and
  // for a queue row followed into History.
  const key = parseJobKey(jobRowId);
  const queueRow = rowOrStale(
    useLiveRow(jobs, key?.kind === "live" ? key.id : null),
  );
  const run = rowOrStale(
    useLiveRow(jobRuns, key?.kind === "run" ? key.id : null),
  );
  return (queueRow ?? run)?.jobName;
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
  const key = parseJobKey(jobRowId);
  return (
    <PaneChrome pane={jobDetailPane}>
      <Inset pad="md">
        {key === null ? (
          <Text tone="muted">This job is no longer listed.</Text>
        ) : key.kind === "live" ? (
          <QueueRowDetail graphileId={key.id} />
        ) : (
          <RunDetailById runId={key.id} />
        )}
      </Inset>
    </PaneChrome>
  );
}

/** The link a bar of the recent-runs strip opens: that row's detail, in place. */
function useRunTarget(): (key: string) => LinkTarget {
  const { tab } = queuePane.useParams();
  const openPane = useOpenPane();
  return (key) =>
    openPane.to(jobDetailPane, { tab, jobRowId: key }, { mode: "swap" });
}

/** A queue row's detail — or, once it has left the queue, the run it became. */
function QueueRowDetail({ graphileId }: { graphileId: string }) {
  const read = useLiveRow(jobs, graphileId);
  const runTarget = useRunTarget();
  // A running row's duration is read against this clock; its cells tick on
  // their own.
  const now = useNow(30_000);
  switch (read.status) {
    case "loading":
      return <Loading />;
    case "error":
      return read.stale !== undefined ? (
        <JobDetail
          row={fromLive(read.stale, now)}
          followed={false}
          runTarget={runTarget}
        />
      ) : (
        <ResourceErrorInline
          variant="block"
          subject="the job queue"
          error={read.error}
          refetch={read.refetch}
        />
      );
    case "ready":
      return read.found ? (
        <JobDetail
          row={fromLive(read.row, now)}
          followed={false}
          runTarget={runTarget}
        />
      ) : (
        <FollowedRun graphileId={graphileId} />
      );
  }
}

/** The newest recorded run of a queue row that has left the queue. */
function FollowedRun({ graphileId }: { graphileId: string }) {
  const runs = useLive(jobRuns, { where: { jobId: graphileId }, limit: 1 });
  const runTarget = useRunTarget();
  return foldResource(runs, {
    loading: () => <Loading />,
    error: (error, stale) =>
      stale?.[0] !== undefined ? (
        <JobDetail row={fromRun(stale[0])} followed runTarget={runTarget} />
      ) : (
        <ResourceErrorInline
          variant="block"
          subject="the job's runs"
          error={error}
          refetch={runs.refetch}
        />
      ),
    ready: (rows) =>
      rows[0] !== undefined ? (
        <JobDetail row={fromRun(rows[0])} followed runTarget={runTarget} />
      ) : (
        // The guard said it exists; it can still vanish under a mounted pane
        // (a pending row cancelled, a run overwritten in its ring).
        <Text tone="muted">This job is no longer listed.</Text>
      ),
  });
}

/** A recorded run's detail. */
function RunDetailById({ runId }: { runId: string }) {
  const read = useLiveRow(jobRuns, runId);
  const runTarget = useRunTarget();
  const run = rowOrStale(read);
  if (run !== undefined) {
    return (
      <JobDetail row={fromRun(run)} followed={false} runTarget={runTarget} />
    );
  }
  switch (read.status) {
    case "loading":
      return <Loading />;
    case "error":
      return (
        <ResourceErrorInline
          variant="block"
          subject="the run"
          error={read.error}
          refetch={read.refetch}
        />
      );
    case "ready":
      // Overwritten in its job's ring under a mounted pane.
      return <Text tone="muted">This run is no longer listed.</Text>;
  }
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
