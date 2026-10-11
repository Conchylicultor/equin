import { useMemo } from "react";
import {
  foldResource,
  matchResource,
} from "@plugins/primitives/plugins/live-state/web";
import type { LinkTarget } from "@plugins/primitives/plugins/link-gesture/core";
import { HOLD_CLASSES, HOLD_SPECS } from "@plugins/infra/plugins/jobs/core";
import {
  DataView,
  defineDataView,
  defineItemActions,
} from "@plugins/primitives/plugins/data-view/web";
import type {
  FieldDef,
  ItemActionProps,
} from "@plugins/primitives/plugins/data-view/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { StatusDot } from "@plugins/primitives/plugins/css/plugins/status-dot/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { useQueueActions } from "../internal/actions";
import { firstLine, formatDuration } from "../internal/format";
import {
  useJobRows,
  type JobListRow,
  type JobRowsData,
} from "../internal/job-rows";
import {
  PROBLEM_OPTIONS,
  STATUS_META,
  STATUS_OPTIONS,
} from "../internal/status";
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
  const fields = useMemo(() => buildFields(rows), [rows]);
  return (
    <DataView<JobListRow>
      storageKey={JOBS_VIEW}
      fields={fields}
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

// The job-name options are read off the rows (a closed set per render): the
// queue's own registry is server-side.
function buildFields(rows: readonly JobListRow[]): FieldDef<JobListRow>[] {
  const jobNames = [...new Set(rows.map((r) => r.jobName))].sort();
  return [
    {
      id: "status",
      label: "Status",
      type: "enum",
      value: (r) => r.status,
      options: STATUS_OPTIONS,
      cell: (r) => (
        <Inline gap="xs">
          <StatusLabel status={r.status} />
          {r.problem !== null && <ProblemBadge problem={r.problem} />}
        </Inline>
      ),
      sortable: true,
      filterable: true,
      width: "max-content",
    },
    {
      // Filter-only: the problem badges already show in the status cell.
      id: "problem",
      label: "Problem",
      type: "enum",
      value: (r) => r.problem,
      options: PROBLEM_OPTIONS,
      sortable: false,
      filterable: true,
      visible: false,
    },
    {
      id: "jobName",
      label: "Job",
      type: "enum",
      value: (r) => r.jobName,
      options: jobNames.map((name) => ({ value: name, label: name })),
      cell: (r) => <JobBadge name={r.jobName} />,
      primary: true,
      sortable: true,
      filterable: true,
      width: "minmax(8rem,16rem)",
    },
    {
      id: "hold",
      label: "Hold",
      type: "enum",
      value: (r) => r.hold,
      options: HOLD_CLASSES.map((hold) => ({
        value: hold,
        label: HOLD_SPECS[hold].label,
      })),
      cell: (r) => (r.hold === null ? null : <HoldBadge hold={r.hold} />),
      sortable: true,
      filterable: true,
      width: "max-content",
    },
    {
      id: "attempt",
      label: "Try",
      type: "int",
      value: (r) => r.attempt,
      cell: (r) => (
        <Text tone="muted" className="tabular-nums">
          {attemptText(r)}
        </Text>
      ),
      sortable: true,
      filterable: true,
      align: "end",
      width: "3rem",
    },
    {
      id: "when",
      label: "When",
      type: "date",
      value: (r) => r.when,
      cell: (r) => (
        <WhenText
          date={r.when}
          prefix={whenPrefix(r)}
          due={r.kind === "live" && r.status === "pending"}
        />
      ),
      sortable: true,
      filterable: true,
      align: "end",
      width: "5.5rem",
    },
    {
      id: "waitMs",
      label: "Waited",
      type: "int",
      value: (r) => r.waitMs,
      cell: (r) =>
        r.waitMs === null ? null : (
          <Text tone="muted" className="tabular-nums">
            {formatDuration(r.waitMs)}
          </Text>
        ),
      sortable: true,
      filterable: true,
      align: "end",
      width: "5.5rem",
    },
    {
      id: "durationMs",
      label: "Duration",
      type: "int",
      value: (r) => r.durationMs,
      cell: (r) =>
        r.runningSince !== null ? (
          <RunningDuration
            since={r.runningSince}
            overCeilingAt={
              r.hold === null ? null : HOLD_SPECS[r.hold].ceilingMs
            }
          />
        ) : r.durationMs === null ? null : (
          <DurationText ms={r.durationMs} hold={r.hold} />
        ),
      sortable: true,
      filterable: true,
      align: "end",
      width: "5.5rem",
    },
    {
      id: "error",
      label: "Error",
      type: "text",
      value: (r) => r.error,
      cell: (r) =>
        r.error === null ? null : (
          <Text variant="code" tone="destructive" title={r.error}>
            {firstLine(r.error)}
          </Text>
        ),
      sortable: false,
      filterable: true,
      width: "minmax(0,1fr)",
    },
    {
      // The default order: in-flight rows first (oldest first), then finished
      // ones newest first. Sort-only.
      id: "order",
      label: "In flight first",
      type: "int",
      value: (r) => r.order,
      sortable: true,
      filterable: false,
      visible: false,
    },
  ];
}
