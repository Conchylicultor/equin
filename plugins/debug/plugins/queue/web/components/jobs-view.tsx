import {
  foldResource,
  matchResource,
} from "@plugins/primitives/plugins/live-state/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { HOLD_SPECS } from "@plugins/infra/plugins/jobs/core";
import {
  DataView,
  defineDataView,
  defineItemActions,
  fieldOverrides,
} from "@plugins/primitives/plugins/data-view/web";
import type { ItemActionProps } from "@plugins/primitives/plugins/data-view/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { jobListRow } from "../../core";
import { useQueueActions } from "../internal/actions";
import { firstLine, formatDuration } from "../internal/format";
import {
  useJobRows,
  type JobListRow,
  type JobRowsData,
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

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const JOBS_VIEW = defineDataView("debug.queue.jobs");

const replayIcon = symbol("replay");
const cancelIcon = symbol("cancel");

/** The Jobs list's per-row actions — Retry and Cancel, each on the rows it applies to. */
export const JobsItemActions = defineItemActions<JobListRow>();

/** Retry a queue row that failed: retrying (waiting on its backoff) or dead. */
export function RetryJobAction({ row }: ItemActionProps<JobListRow>) {
  const actions = useQueueActions();
  if (row.kind !== "live") return null;
  if (row.status !== "retrying" && row.status !== "dead") return null;
  const id = row.job.id;
  return (
    <IconButton
      icon={replayIcon}
      label="Retry now"
      onClick={() => actions.retryJob(id)}
    />
  );
}

/** Cancel a queue row that has not started. */
export function CancelJobAction({ row }: ItemActionProps<JobListRow>) {
  const actions = useQueueActions();
  if (row.kind !== "live" || row.status !== "pending") return null;
  const id = row.job.id;
  return (
    <IconButton
      icon={cancelIcon}
      label="Cancel job"
      onClick={() => actions.cancelJob(id)}
    />
  );
}

/**
 * Debug → Queue's Jobs section: ONE DataView over every job the queue knows —
 * the live graphile rows (pending / running / retrying / dead) and the
 * recorded finished runs — merged on the client (see `useJobRows`). The views
 * (`config/debug/queue/debug.queue.jobs.jsonc`) are filters and sorts over it:
 * in flight first, active only, problems, slowest, by job.
 */
export function JobsView({
  selectedKey,
  linkTo,
}: {
  selectedKey?: string;
  linkTo: (key: string) => LinkTarget;
}) {
  const result = useJobRows();
  // The DataView renders the loading and failed states (`readiness`); only a
  // ready read's rows reach the view.
  const rows = foldResource(result, {
    loading: () => NO_ROWS,
    error: () => NO_ROWS,
    ready: (d) => d.rows,
  });
  return (
    <DataView<JobListRow>
      storageKey={JOBS_VIEW}
      collection={jobListRow}
      overrides={overrides}
      views={["table", "list"]}
      defaultView="table"
      rows={rows}
      readiness={result}
      rowKey={(r) => r.key}
      searchAccessor={(r) =>
        [r.jobName, r.status, r.error ?? "", r.key].join(" ")
      }
      searchPlaceholder="Search jobs…"
      selectedRowId={selectedKey}
      rowActivation={(r) => linkTo(r.key)}
      itemActions={JobsItemActions}
      actions={matchResource(result, {
        loading: () => null,
        error: () => null,
        ready: (d) => <QueueCounts data={d} />,
      })}
      emptyState={<>No jobs in the queue and no recorded runs.</>}
    />
  );
}

const NO_ROWS: readonly JobListRow[] = [];

/** The live queue's per-state counts, as the toolbar's trailing summary. */
function QueueCounts({ data }: { data: JobRowsData }) {
  const { counts } = data;
  return (
    <Inline gap="sm">
      {(["pending", "running", "retrying", "dead"] as const).map((state) => (
        <Inline key={state} gap="2xs">
          <StatusDot colorClass={STATUS_META[state].dot} />
          <Text variant="caption" tone="muted" className="tabular-nums">
            {counts[state]} {state}
          </Text>
        </Inline>
      ))}
    </Inline>
  );
}

/**
 * What the Try column says: `n/max` for a queue row that has run, a retried
 * run's attempt — bare `n` for a run recorded before history kept the budget.
 */
function attemptText(r: JobListRow): string {
  const shown = r.kind === "live" ? r.attempt > 0 : r.attempt > 1;
  if (!shown) return "";
  return r.maxAttempts === null
    ? String(r.attempt)
    : `${r.attempt}/${r.maxAttempts}`;
}

function whenPrefix(r: JobListRow): string {
  if (r.kind === "run") return "Finished";
  return r.status === "running" ? "Started" : "Run at";
}

// How the derived fields present here (the `jobListRow` kind declares their
// labels and types, the presentation their options). The row is annotated, not
// inferred: a Jobs row carries more than the kind's declared fields.
const overrides = fieldOverrides(jobListRow, {
  status: {
    cell: (r: JobListRow) => (
      <Inline gap="xs">
        <StatusLabel status={r.status} />
        {r.problem !== null && <ProblemBadge problem={r.problem} />}
      </Inline>
    ),
    width: "max-content",
  },
  // Filter-only: the problem badges already show in the status cell.
  problem: { visible: false },
  jobName: {
    cell: (r: JobListRow) => <JobBadge name={r.jobName} />,
    width: "minmax(8rem,16rem)",
  },
  hold: {
    cell: (r: JobListRow) =>
      r.hold === null ? null : <HoldBadge hold={r.hold} />,
    width: "max-content",
  },
  attempt: {
    cell: (r: JobListRow) => (
      <Text tone="muted" className="tabular-nums">
        {attemptText(r)}
      </Text>
    ),
    align: "end",
    width: "3rem",
  },
  when: {
    cell: (r: JobListRow) => (
      <WhenText
        date={r.when}
        prefix={whenPrefix(r)}
        due={r.kind === "live" && r.status === "pending"}
      />
    ),
    align: "end",
    width: "5.5rem",
  },
  waitMs: {
    cell: (r: JobListRow) =>
      r.waitMs === null ? null : (
        <Text tone="muted" className="tabular-nums">
          {formatDuration(r.waitMs)}
        </Text>
      ),
    align: "end",
    width: "5.5rem",
  },
  durationMs: {
    cell: (r: JobListRow) =>
      r.runningSince !== null ? (
        <RunningDuration
          since={r.runningSince}
          overCeilingAt={r.hold === null ? null : HOLD_SPECS[r.hold].ceilingMs}
        />
      ) : r.durationMs === null ? null : (
        <DurationText ms={r.durationMs} hold={r.hold} />
      ),
    align: "end",
    width: "5.5rem",
  },
  error: {
    cell: (r: JobListRow) =>
      r.error === null ? null : (
        <Text variant="code" tone="destructive" title={r.error}>
          {firstLine(r.error)}
        </Text>
      ),
    width: "minmax(0,1fr)",
  },
  order: { visible: false },
});
