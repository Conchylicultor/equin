import { useMemo, type ReactElement } from "react";
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
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { loadSeverity } from "@plugins/debug/plugins/slow-ops/core";
import { useClusterStream } from "../internal/use-cluster-stream";
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

export function ClusterView(): ReactElement {
  const { worktrees, total, status, error, reload } = useClusterStream();

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
        width: "4rem",
        align: "end",
        value: (r) => r.count,
      },
      {
        id: "totalMs",
        label: "Total (ms)",
        type: "number",
        width: "5.5rem",
        align: "end",
        value: (r) => Math.round(r.totalMs),
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

  return (
    <Scroll axis="both" className="h-full">
      <Stack gap="xl" className="px-md py-md">
        <Stack direction="row" align="center" gap="md">
          <Stack as={Fill} gap="2xs">
            <SectionLabel>Cross-worktree cluster</SectionLabel>
            {status === "streaming" && (
              <ScanProgress received={worktrees.length} total={total} />
            )}
            {status === "done" && (
              <Text
                as="span"
                variant="caption"
                className="text-muted-foreground"
              >
                {okCount} worktree{okCount === 1 ? "" : "s"} merged
                {failed.length > 0 && " "}
                {failed.length > 0 && (
                  <span
                    className="text-warning"
                    title={failed
                      .map((f) => `${f.name}: ${f.error}`)
                      .join("\n")}
                  >
                    · {failed.length} failed to load
                  </span>
                )}
              </Text>
            )}
            {status === "error" && error && (
              <Placeholder tone="error">{error}</Placeholder>
            )}
          </Stack>
          <Button
            variant="outline"
            loading={status === "streaming"}
            onClick={() => void reload()}
          >
            Refresh
          </Button>
        </Stack>

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
      </Stack>
    </Scroll>
  );
}
