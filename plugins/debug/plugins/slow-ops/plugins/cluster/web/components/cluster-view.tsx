import { useMemo, useState, type ReactElement, type ReactNode } from "react";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import { Scroll } from "@plugins/primitives/plugins/css/plugins/scroll/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { yieldClass } from "@plugins/primitives/plugins/css/plugins/yield/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { loadSeverity } from "@plugins/debug/plugins/slow-ops/core";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import {
  CLUSTER_OPS_PER_WORKTREE,
  clusterScan,
  type ClusterScan,
} from "../../shared/scan";
import { ScanProgress } from "./scan-progress";
import {
  buildClusterAggregate,
  buildContentionTimeline,
  failedWorktrees,
  type ClusterAggregate,
  type TimelineEntry,
} from "../internal/aggregate";

// Each stacked DataView needs a unique surface id (its config + per-device state
// home). Aggregate is ranked by cluster-wide impact (total time across every
// worktree); timeline is newest-first — both via config-authored default sort.
const CLUSTER_AGG = defineDataView("debug.slow-ops.cluster-aggregate");
const CLUSTER_TIMELINE = defineDataView("debug.slow-ops.cluster-timeline");

function uniqueSorted(values: string[]): { value: string; label: string }[] {
  return [...new Set(values)].sort().map((v) => ({ value: v, label: v }));
}

/**
 * The Cluster tab: one scan of every live worktree DB fork per mount and per
 * Refresh (`debug.slow-ops.cluster.scan`, each a new question at the clock's
 * now), filled in live as each fork answers; a finished scan never moves.
 */
export function ClusterView(): ReactElement {
  // The instant the scan is asked for — a new one is a new scan.
  const [at, setAt] = useState(() => Date.now());
  const read = useLive(clusterScan, { at });
  const refresh = (scanning: boolean): ReactNode => (
    <Button
      variant="outline"
      loading={scanning}
      onClick={() => setAt(Date.now())}
    >
      Refresh
    </Button>
  );
  switch (read.status) {
    case "loading":
      return (
        <ClusterFrame
          status={<ScanProgress received={0} total={null} />}
          refresh={refresh(true)}
        />
      );
    case "error":
      return (
        <ClusterFrame
          status={
            <ResourceErrorInline
              error={read.error}
              // A failed scan is held as failed: Retry asks a new question.
              refetch={async () => setAt(Date.now())}
              variant="inline"
              subject="the cluster"
            />
          }
          refresh={refresh(false)}
        />
      );
    case "ready":
      return (
        <ClusterScanView
          scan={read.data}
          refresh={refresh(!read.data.complete)}
        />
      );
  }
}

/**
 * A summed count or time: prefixed ≥ when a truncated fork did not report the
 * op — it may sit below that fork's heaviest {@link CLUSTER_OPS_PER_WORKTREE},
 * so the sum is a lower bound.
 */
function AtLeast({
  row,
  value,
}: {
  row: ClusterAggregate;
  value: number;
}): ReactElement {
  if (row.maybeUncountedIn.length === 0) return <>{value}</>;
  return (
    <span
      title={`Not among the heaviest ${CLUSTER_OPS_PER_WORKTREE} ops read from: ${row.maybeUncountedIn.join(", ")}`}
    >
      ≥ {value}
    </span>
  );
}

/** The tab's chrome — its label, the scan's state and Refresh — over `children`. */
function ClusterFrame({
  status,
  refresh,
  children,
}: {
  status: ReactNode;
  refresh: ReactNode;
  children?: ReactNode;
}): ReactElement {
  return (
    <Scroll axis="both" className="h-full">
      <Stack gap="xl" className="px-md py-md">
        <Stack direction="row" align="center" gap="md">
          <Stack as={Fill} gap="2xs">
            <SectionLabel>Cross-worktree cluster</SectionLabel>
            {status}
          </Stack>
          {refresh}
        </Stack>
        {children}
      </Stack>
    </Scroll>
  );
}

/** One scan, as far as it got: the merged aggregate and contention timeline. */
function ClusterScanView({
  scan,
  refresh,
}: {
  scan: ClusterScan;
  refresh: ReactNode;
}): ReactElement {
  const { worktrees, total, complete } = scan;

  const aggregates = useMemo(
    () => buildClusterAggregate(worktrees),
    [worktrees],
  );
  const timeline = useMemo(
    () => buildContentionTimeline(worktrees),
    [worktrees],
  );
  const failed = useMemo(() => failedWorktrees(worktrees), [worktrees]);

  const okCount = worktrees.length - failed.length;

  const aggFields: FieldDef<ClusterAggregate>[] = useMemo(
    () => [
      {
        id: "operationKind",
        label: "Kind",
        type: "enum",
        width: "7rem",
        value: (r) => r.operationKind,
        options: uniqueSorted(aggregates.map((r) => r.operationKind)),
      },
      {
        id: "operation",
        label: "Operation",
        type: "text",
        primary: true,
        width: "minmax(0,1fr)",
        value: (r) => r.operation,
        cell: (r) => (
          <Stack gap="2xs" className={yieldClass("x")}>
            <Text
              as="span"
              variant="caption"
              className="truncate font-mono"
              title={r.operation}
            >
              {r.operation}
            </Text>
            <Text
              as="span"
              variant="caption"
              className="pl-md text-3xs text-muted-foreground"
              title={r.worktrees.join(", ")}
            >
              slow across {r.worktrees.length} worktree
              {r.worktrees.length === 1 ? "" : "s"}
            </Text>
          </Stack>
        ),
      },
      {
        id: "worktrees",
        label: "Worktrees",
        type: "number",
        width: "5.5rem",
        align: "end",
        value: (r) => r.worktrees.length,
      },
      {
        id: "count",
        label: "Count",
        type: "number",
        width: "5.5rem",
        align: "end",
        value: (r) => r.count,
        cell: (r) => <AtLeast row={r} value={r.count} />,
      },
      {
        id: "totalMs",
        label: "Total (ms)",
        type: "number",
        width: "7.5rem",
        align: "end",
        value: (r) => Math.round(r.totalMs),
        cell: (r) => <AtLeast row={r} value={Math.round(r.totalMs)} />,
      },
      {
        id: "maxMs",
        label: "Max (ms)",
        type: "number",
        width: "5rem",
        align: "end",
        value: (r) => Math.round(r.maxMs),
      },
      {
        id: "lastSeen",
        label: "Last seen",
        type: "date",
        width: "7rem",
        align: "end",
        value: (r) => r.lastSeenAt,
        cell: (r) => (
          <Text as="span" variant="caption" className="text-muted-foreground">
            <RelativeTime date={r.lastSeenAt} />
          </Text>
        ),
      },
    ],
    [aggregates],
  );

  const timelineFields: FieldDef<TimelineEntry>[] = useMemo(
    () => [
      {
        id: "atTime",
        label: "When",
        type: "date",
        width: "6rem",
        align: "end",
        value: (r) => r.atTime,
        cell: (r) => (
          <Text as="span" variant="caption" className="text-muted-foreground">
            <RelativeTime date={r.atTime} />
          </Text>
        ),
      },
      {
        id: "worktree",
        label: "Worktree",
        type: "enum",
        width: "9rem",
        value: (r) => r.worktree,
        options: uniqueSorted(timeline.map((r) => r.worktree)),
        cell: (r) => (
          <Badge
            variant="muted"
            className="truncate font-mono"
            tooltip={r.worktree}
          >
            {r.worktree}
          </Badge>
        ),
      },
      {
        id: "operationKind",
        label: "Kind",
        type: "enum",
        width: "7rem",
        value: (r) => r.operationKind,
        options: uniqueSorted(timeline.map((r) => r.operationKind)),
      },
      {
        id: "operation",
        label: "Operation",
        type: "text",
        primary: true,
        width: "minmax(0,1fr)",
        value: (r) => r.operation,
        cell: (r) => (
          <Text
            as="span"
            variant="caption"
            className="truncate font-mono"
            title={`${r.operationKind} ${r.operation}`}
          >
            <span className="text-muted-foreground">{r.operationKind}</span>{" "}
            {r.operation}
          </Text>
        ),
      },
      {
        id: "durationMs",
        label: "Dur (ms)",
        type: "number",
        width: "5rem",
        align: "end",
        value: (r) => Math.round(r.durationMs),
      },
      {
        id: "load",
        label: "load1 / cpu",
        type: "number",
        width: "6rem",
        align: "end",
        value: (r) => r.loadAvg1,
        cell: (r) => (
          <Badge
            variant={loadSeverity(r.loadAvg1, r.cpuCount)}
            className="font-mono"
          >
            {Math.round(r.loadAvg1)} / {r.cpuCount}
          </Badge>
        ),
      },
      {
        id: "pgActiveBackends",
        label: "pg active",
        type: "number",
        width: "5rem",
        align: "end",
        value: (r) => r.pgActiveBackends,
      },
    ],
    [timeline],
  );

  // Forks holding more rows than the scan reads (their heaviest only).
  const truncated = worktrees.filter((w) => w.opCount > w.ops.length);

  return (
    <ClusterFrame
      refresh={refresh}
      status={
        complete ? (
          <Text as="span" variant="caption" className="text-muted-foreground">
            {okCount} worktree{okCount === 1 ? "" : "s"} merged
            {failed.length > 0 && " "}
            {failed.length > 0 && (
              <span
                className="text-warning"
                title={failed.map((f) => `${f.name}: ${f.error}`).join("\n")}
              >
                · {failed.length} failed to load
              </span>
            )}
            {truncated.length > 0 && (
              <span
                title={truncated
                  .map((w) => `${w.name}: ${w.opCount} ops`)
                  .join("\n")}
              >
                {" "}
                · totals cover the heaviest {CLUSTER_OPS_PER_WORKTREE} ops of{" "}
                {truncated.length} worktree{truncated.length === 1 ? "" : "s"}{" "}
                (≥ marks a sum that may miss one)
              </span>
            )}
          </Text>
        ) : (
          <ScanProgress received={worktrees.length} total={total} />
        )
      }
    >
        <DataView<ClusterAggregate>
          rows={aggregates}
          fields={aggFields}
          rowKey={(r) => r.key}
          storageKey={CLUSTER_AGG}
          title="Cluster Aggregate"
          defaultView="table"
          emptyState="No slow operations recorded across the cluster"
        />

      <DataView<TimelineEntry>
        rows={timeline}
          fields={timelineFields}
          rowKey={(r) => r.key}
          storageKey={CLUSTER_TIMELINE}
          title="Contention Timeline"
          defaultView="table"
          emptyState="No contention samples captured yet"
        />
    </ClusterFrame>
  );
}
