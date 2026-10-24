import {
  matchResource,
  ResourceErrorInline,
} from "@plugins/primitives/plugins/live-state/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import {
  HOLD_SPECS,
  JOB_STATES,
  jobRuns,
  jobs,
  type JobRow,
  type JobRunRow,
} from "@plugins/infra/plugins/jobs/core";
import { useLive } from "@plugins/network/plugins/live/web";
import {
  DataView,
  defineDataView,
  defineItemActions,
  fieldOverrides,
  liveDataSource,
} from "@plugins/primitives/plugins/data-view/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useQueueActions } from "../internal/actions";
import { firstLine, formatDuration } from "../internal/format";
import {
  liveKey,
  parseJobKey,
  problemOf,
  runKey,
  type JobKey,
} from "../internal/job-rows";
import { STATUS_META } from "../internal/status";
import {
  DurationText,
  HoldBadge,
  JobBadge,
  ProblemBadge,
  RunningDuration,
  StatusLabel,
  WhenText,
} from "./cells";

// Markers scraped by codegen (data-views.generated.ts). Must live in web/**.
const QUEUE_VIEW = defineDataView("debug.queue.jobs");
const HISTORY_VIEW = defineDataView("debug.queue.history");

const replayIcon = symbol("replay");
const cancelIcon = symbol("cancel");

// The two job sources, each a live window: sort / filter / search compile on
// the server (the queue's own SQL, `job_runs`' compiled one), and the Job
// filter options are a facet — a grouping of the whole source, not of the
// loaded rows. A job is a Queue row until its run finishes, then a History
// row: the two never hold the same run, so they are two lists, not one merge.
const queueSource = liveDataSource(jobs, {
  searchable: ["jobName", "lastError"],
  facets: ["jobName"],
});
const historySource = liveDataSource(jobRuns, {
  searchable: ["jobName", "error"],
  facets: ["jobName"],
});

/** The Queue list's per-row actions — Retry and Cancel, each on the rows it applies to. */
export const JobsItemActions = defineItemActions<JobRow>();

/** Retry a queue row that failed: retrying (waiting on its backoff) or dead. */
export function RetryJobAction({ row }: ItemActionProps<JobRow>) {
  const actions = useQueueActions();
  if (row.state !== "retrying" && row.state !== "dead") return null;
  const id = row.id;
  return (
    <IconButton
      icon={replayIcon}
      label="Retry now"
      onClick={() => actions.retryJob(id)}
    />
  );
}

/** Cancel a queue row that has not started. */
export function CancelJobAction({ row }: ItemActionProps<JobRow>) {
  const actions = useQueueActions();
  if (row.state !== "pending") return null;
  const id = row.id;
  return (
    <IconButton
      icon={cancelIcon}
      label="Cancel job"
      onClick={() => actions.cancelJob(id)}
    />
  );
}

/**
 * Debug → Queue's Queue section: the host's job queue (`jobs`) — pending,
 * running, retrying and dead rows — newest run-at first. The views
 * (`config/debug/queue/debug.queue.jobs.jsonc`) are filters over it.
 */
export function QueueView({
  selectedKey,
  linkTo,
}: {
  selectedKey?: string;
  linkTo: (key: string) => LinkTarget;
}) {
  return (
    <DataView<JobRow>
      storageKey={QUEUE_VIEW}
      overrides={queueOverrides}
      views={["table", "list"]}
      defaultView="table"
      source={queueSource}
      searchPlaceholder="Search the queue…"
      selectedRowId={selectedIdOf(selectedKey, "live")}
      rowActivation={(r) => linkTo(liveKey(r.id))}
      itemActions={JobsItemActions}
      actions={<QueueCounts />}
      emptyState={<>The queue is empty — finished runs are in History.</>}
    />
  );
}

/**
 * Debug → Queue's History section: every recorded run (`jobRuns`, a ring of
 * the last 20 per job), newest finished first. The views
 * (`config/debug/queue/debug.queue.history.jsonc`) are filters and sorts over
 * it: failed, slowest, by job.
 */
export function HistoryView({
  selectedKey,
  linkTo,
}: {
  selectedKey?: string;
  linkTo: (key: string) => LinkTarget;
}) {
  return (
    <DataView<JobRunRow>
      storageKey={HISTORY_VIEW}
      overrides={historyOverrides}
      views={["table", "list"]}
      defaultView="table"
      source={historySource}
      searchPlaceholder="Search runs…"
      selectedRowId={selectedIdOf(selectedKey, "run")}
      rowActivation={(r) => linkTo(runKey(r.id))}
      emptyState={<>No recorded runs yet.</>}
    />
  );
}

/** The row id an open detail's key selects in the list of `kind` — none when it names the other list's row. */
function selectedIdOf(
  key: string | undefined,
  kind: JobKey["kind"],
): string | undefined {
  const parsed = key === undefined ? null : parseJobKey(key);
  return parsed?.kind === kind ? parsed.id : undefined;
}

/** The whole queue's per-state counts (a `:groups` read), as the toolbar's trailing summary. */
function QueueCounts() {
  const groups = useLive(jobs, { groupBy: "state" });
  return matchResource(groups, {
    loading: () => null,
    // A failed count is shown, never left out: an icon in the toolbar's
    // trailing slot, its message and Retry on hover / click.
    error: (error) => (
      <ResourceErrorInline
        variant="icon"
        subject="the queue's counts"
        error={error}
        refetch={groups.status === "error" ? groups.refetch : undefined}
      />
    ),
    ready: (rows) => {
      const count = (state: string) =>
        rows.find((g) => g.value === state)?.count ?? 0;
      return (
        <Inline gap="sm">
          {JOB_STATES.map((state) => (
            <Inline key={state} gap="2xs">
              <StatusDot colorClass={STATUS_META[state].dot} />
              <Text variant="caption" tone="muted" className="tabular-nums">
                {count(state)} {state}
              </Text>
            </Inline>
          ))}
        </Inline>
      );
    },
  });
}

/** What the Attempts column says of a queue row: `n/max` once it has run. */
function attemptsText(r: JobRow): string {
  return r.attempts > 0 ? `${r.attempts}/${r.maxAttempts}` : "";
}

/** What the Try column says of a run: a retried run's attempt — bare `n` for a run recorded before history kept the budget. */
function attemptText(r: JobRunRow): string {
  if (r.attempt <= 1) return "";
  return r.maxAttempts === null
    ? String(r.attempt)
    : `${r.attempt}/${r.maxAttempts}`;
}

function errorCell(error: string | null) {
  return error === null ? null : (
    <Text variant="code" tone="destructive" title={error}>
      {firstLine(error)}
    </Text>
  );
}

// How the derived fields present here (each collection declares their labels,
// types and filters; the presentation registry their options).
const queueOverrides = fieldOverrides(jobs, {
  state: {
    cell: (r) => {
      const problem = problemOf(r);
      return (
        <Inline gap="xs">
          <StatusLabel status={r.state} />
          {problem !== null && <ProblemBadge problem={problem} />}
        </Inline>
      );
    },
    width: "max-content",
  },
  jobName: {
    cell: (r) => <JobBadge name={r.jobName} />,
    width: "minmax(8rem,16rem)",
  },
  hold: {
    cell: (r) => (r.hold === null ? null : <HoldBadge hold={r.hold} />),
    width: "max-content",
  },
  attempts: {
    cell: (r) => (
      <Text tone="muted" className="tabular-nums">
        {attemptsText(r)}
      </Text>
    ),
    align: "end",
    width: "4rem",
  },
  runAt: {
    // A running row reads when it started, and how long it has been running.
    cell: (r) =>
      r.state === "running" && r.lockedAt !== null ? (
        <Inline gap="xs">
          <WhenText date={r.lockedAt} prefix="Started" />
          <RunningDuration
            since={r.lockedAt}
            overCeilingAt={
              r.hold === null ? null : HOLD_SPECS[r.hold].ceilingMs
            }
          />
        </Inline>
      ) : (
        <WhenText date={r.runAt} prefix="Run at" due={r.state === "pending"} />
      ),
    align: "end",
    width: "max-content",
  },
  lastError: {
    cell: (r) => errorCell(r.lastError),
    width: "minmax(0,1fr)",
  },
});

const historyOverrides = fieldOverrides(jobRuns, {
  outcome: {
    cell: (r) => <StatusLabel status={r.outcome} />,
    width: "max-content",
  },
  jobName: {
    cell: (r) => <JobBadge name={r.jobName} />,
    width: "minmax(8rem,16rem)",
  },
  hold: {
    cell: (r) => (r.hold === null ? null : <HoldBadge hold={r.hold} />),
    width: "max-content",
  },
  attempt: {
    cell: (r) => (
      <Text tone="muted" className="tabular-nums">
        {attemptText(r)}
      </Text>
    ),
    align: "end",
    width: "3rem",
  },
  finishedAt: {
    cell: (r) => <WhenText date={r.finishedAt} prefix="Finished" />,
    align: "end",
    width: "5.5rem",
  },
  durationMs: {
    cell: (r) => <DurationText ms={r.durationMs} hold={r.hold} />,
    align: "end",
    width: "5.5rem",
  },
  waitMs: {
    cell: (r) =>
      r.waitMs === null ? null : (
        <Text tone="muted" className="tabular-nums">
          {formatDuration(r.waitMs)}
        </Text>
      ),
    align: "end",
    width: "5.5rem",
  },
  error: {
    cell: (r) => errorCell(r.error),
    width: "minmax(0,1fr)",
  },
  // Filter-only: what a detail pane follows a finished queue row by.
  jobId: { visible: false },
});
