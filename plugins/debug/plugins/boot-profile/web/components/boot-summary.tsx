import { type ReactElement } from "react";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { SectionLabel } from "@plugins/primitives/plugins/css/plugins/text/web";
import { DataTable, type ColumnDef } from "@plugins/primitives/plugins/data-table/web";
import { formatDuration } from "@plugins/debug/plugins/profiling/web";
import {
  bootWindowEnd,
  type BootTrace,
} from "@plugins/primitives/plugins/perfs/plugins/boot-trace/web";

interface SummaryRow {
  label: string;
  /** Absolute offset on the boot clock (ms), or null when unavailable. */
  atMs: number | null;
}

const COLUMNS: ColumnDef<SummaryRow>[] = [
  { id: "label", header: "Milestone", value: (r) => r.label },
  {
    id: "at",
    header: "At",
    align: "end",
    width: "8rem",
    value: (r) => r.atMs ?? Number.POSITIVE_INFINITY,
    cell: (r) =>
      r.atMs === null ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="font-mono tabular-nums">+{formatDuration(r.atMs)}</span>
      ),
  },
];

/** End offset (startMs + durationMs) of the first span with the given id. */
function spanEnd(trace: BootTrace, id: string): number | null {
  const span = trace.spans.find((s) => s.id === id);
  return span ? span.startMs + span.durationMs : null;
}

interface StatRow {
  label: string;
  value: string;
}

const STAT_COLUMNS: ColumnDef<StatRow>[] = [
  { id: "label", header: "Cost", value: (r) => r.label },
  {
    id: "value",
    header: "",
    align: "end",
    width: "14rem",
    value: (r) => r.value,
    cell: (r) => <span className="font-mono tabular-nums">{r.value}</span>,
  },
];

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

/** Bundle/main-thread cost headline — the levers behind the pre-paint window. */
function costRows(trace: BootTrace): StatRow[] {
  const scripts = trace.assets.filter((a) => a.initiatorType === "script");
  const jsBytes = scripts.reduce((sum, a) => sum + a.transferSize, 0);
  const biggest = trace.assets.reduce<BootTrace["assets"][number] | null>(
    (max, a) => (max === null || a.transferSize > max.transferSize ? a : max),
    null,
  );
  const windowEnd = bootWindowEnd(trace);
  const bootTasks =
    windowEnd > 0 ? trace.longTasks.filter((t) => t.startMs <= windowEnd) : trace.longTasks;
  const busyMs = bootTasks.reduce((sum, t) => sum + t.durationMs, 0);

  return [
    { label: "JS shipped", value: `${formatBytes(jsBytes)} · ${scripts.length} chunks` },
    {
      label: "Biggest chunk",
      value: biggest ? `${biggest.name.split("/").pop()} · ${formatBytes(biggest.transferSize)}` : "—",
    },
    {
      label: "Main thread busy (before paint)",
      value: bootTasks.length > 0 ? `${formatDuration(busyMs)} · ${bootTasks.length} tasks` : "—",
    },
  ];
}

/**
 * Headline "request → first paint" decomposition in one glance: TTFB, response
 * end, plugin load, boot tasks, first React commit, first-contentful-paint.
 */
export function BootSummary({ trace }: { trace: BootTrace }): ReactElement {
  const nav = trace.navigation;
  const rows: SummaryRow[] = [
    { label: "TTFB (response start)", atMs: nav?.responseStartMs ?? null },
    { label: "Response end", atMs: nav?.responseEndMs ?? null },
    { label: "Plugins loaded", atMs: spanEnd(trace, "load-plugins") },
    { label: "Boot tasks done", atMs: spanEnd(trace, "boot-tasks") },
    { label: "First React commit", atMs: trace.firstCommitMs },
    {
      label: "First-contentful-paint",
      atMs: trace.paint.firstContentfulPaintMs,
    },
  ];

  // The section opens a region on the pane edge (`rail-document`, the edge the
  // pane header stands on): its tables bleed their rows to the pane and keep
  // their text on the edge, instead of padding a box the tables' rows would
  // then pay the pane edge inside a second time.
  return (
    <div className="rail-document">
      <Stack as="section" gap="lg">
        <Stack gap="sm">
          <SectionLabel>Boot milestones (request → first paint)</SectionLabel>
          <DataTable
            data={rows}
            columns={COLUMNS}
            rowKey={(r) => r.label}
            emptyLabel="No boot trace captured."
          />
        </Stack>
        <Stack gap="sm">
          <SectionLabel>Boot cost (the pre-paint blind spot)</SectionLabel>
          <DataTable
            data={costRows(trace)}
            columns={STAT_COLUMNS}
            rowKey={(r) => r.label}
            emptyLabel="No assets captured."
          />
        </Stack>
      </Stack>
    </div>
  );
}
