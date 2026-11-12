import { useState, type ReactElement } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ChartState,
  axisProps,
  gridProps,
  lineCursor,
  tooltipContentStyle,
  tooltipLabelStyle,
  yAxisFormatter,
} from "@plugins/stats/plugins/commits/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import {
  SectionLabel,
  Text,
} from "@plugins/primitives/plugins/css/plugins/text/web";
import {
  Inset,
  Stack,
} from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { formatDuration } from "@plugins/fields/plugins/duration/core";
import {
  DataView,
  defineDataView,
  type FieldDef,
} from "@plugins/primitives/plugins/data-view/web";
import {
  jsHeapGrowthMbPerHour,
  tabMemorySeries,
  type PageSeries,
  type RendererSeries,
  type TabMemorySample,
} from "../../core";

// Marker scraped by codegen (data-views.generated.ts). Must live in web/**.
const PAGES_VIEW = defineDataView("debug.tab-memory.pages");

const COLORS = Array.from(
  { length: 8 },
  (_, i) => `var(--categorical-${i + 1})`,
);
const colorAt = (i: number): string => COLORS[i % COLORS.length]!;

const fmtTime = (v: number): string =>
  new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtMb = (mb: number): string =>
  mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${Math.round(mb)} MB`;

interface SeriesSpec {
  key: string;
  label: string;
  points: { t: number; v: number | null }[];
  emphasis: boolean;
}

/** One line per series on a shared numeric time axis. */
function SeriesChart({
  series,
  domain,
  format,
  emptyText,
}: {
  series: SeriesSpec[];
  domain: [number, number];
  format: (v: number) => string;
  emptyText: string;
}): ReactElement {
  const anyEmphasis = series.some((s) => s.emphasis);
  return (
    <div className="h-56 w-full">
      <ChartState empty={series.length === 0} emptyText={emptyText}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
            <CartesianGrid {...gridProps} />
            <XAxis
              dataKey="t"
              type="number"
              domain={domain}
              {...axisProps}
              tickFormatter={fmtTime}
              minTickGap={48}
            />
            <YAxis {...axisProps} width={56} tickFormatter={yAxisFormatter} />
            {/* Each line has its own time points (renderers every 2 min, each
                page on its own 5-min clock), so the tooltip names the hovered
                line only rather than lining series up by index. */}
            <Tooltip
              shared={false}
              isAnimationActive={false}
              contentStyle={tooltipContentStyle}
              labelStyle={tooltipLabelStyle}
              cursor={lineCursor}
              labelFormatter={(v) => fmtTime(Number(v))}
              formatter={(v) => format(Number(v))}
            />
            {series.map((s, i) => (
              <Line
                key={s.key}
                data={s.points}
                dataKey="v"
                name={s.label}
                stroke={colorAt(i)}
                strokeWidth={s.emphasis ? 3 : 1.5}
                strokeOpacity={anyEmphasis && !s.emphasis ? 0.35 : 1}
                dot={false}
                connectNulls
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </ChartState>
    </div>
  );
}

function pageLabel(s: TabMemorySample): string {
  return `${s.host}${s.route}`;
}

/** "agents ×3, sonata": the apps a page holds mounted, by count. */
function heldApps(s: TabMemorySample): string {
  const counts = new Map<string, number>();
  for (const t of s.inAppTabs)
    counts.set(t.appId, (counts.get(t.appId) ?? 0) + 1);
  return [...counts]
    .map(([app, n]) => (n > 1 ? `${app} ×${n}` : app))
    .join(", ");
}

const fields: FieldDef<PageSeries>[] = [
  {
    id: "page",
    label: "Route",
    type: "text",
    primary: true,
    // The route alone: the host is the worktree's, in its own column.
    value: (p) => p.latest.route,
    sortable: true,
    filterable: false,
  },
  {
    id: "worktree",
    label: "Worktree",
    type: "text",
    value: (p) => p.worktree,
    sortable: true,
    filterable: false,
  },
  {
    id: "app",
    label: "Focused app",
    type: "text",
    value: (p) => p.latest.focusedAppId ?? "",
    sortable: true,
    filterable: false,
  },
  {
    id: "inAppTabs",
    label: "In-app tabs",
    type: "number",
    value: (p) => p.latest.inAppTabs.length,
    cell: (p) => (
      <Text variant="caption" tone="muted" title={heldApps(p.latest)}>
        {p.latest.inAppTabs.length} — {heldApps(p.latest)}
      </Text>
    ),
    sortable: true,
    width: "14rem",
  },
  {
    id: "jsHeap",
    label: "JS heap",
    type: "number",
    value: (p) => p.latest.jsHeapUsedMb,
    cell: (p) =>
      p.latest.jsHeapUsedMb === null ? null : (
        <Text variant="caption" className="tabular-nums">
          {fmtMb(p.latest.jsHeapUsedMb)}
        </Text>
      ),
    sortable: true,
    width: "6rem",
  },
  {
    id: "growth",
    label: "Heap MB/h",
    type: "number",
    value: (p) => jsHeapGrowthMbPerHour(p),
    cell: (p) => {
      const g = jsHeapGrowthMbPerHour(p);
      return g === null ? null : (
        <Text variant="caption" className="tabular-nums">
          {g >= 0 ? "+" : ""}
          {Math.round(g)}
        </Text>
      );
    },
    sortable: true,
    width: "6rem",
  },
  {
    id: "domNodes",
    label: "DOM nodes",
    type: "number",
    value: (p) => p.latest.domNodes,
    cell: (p) => (
      <Text variant="caption" className="tabular-nums">
        {p.first.domNodes.toLocaleString()} →{" "}
        {p.latest.domNodes.toLocaleString()}
      </Text>
    ),
    sortable: true,
    width: "9rem",
  },
  {
    id: "pixels",
    label: "Canvas + images",
    type: "number",
    value: (p) => p.latest.canvasMb + p.latest.imagesMb,
    cell: (p) => (
      <Text variant="caption" className="tabular-nums">
        {fmtMb(p.latest.canvasMb + p.latest.imagesMb)}
      </Text>
    ),
    sortable: true,
    width: "7rem",
  },
  {
    id: "age",
    label: "Age",
    type: "number",
    value: (p) => p.latest.sampledAt - p.latest.pageStartedAt,
    cell: (p) => (
      <Text variant="caption" tone="muted" className="tabular-nums">
        {formatDuration(p.latest.sampledAt - p.latest.pageStartedAt)}
      </Text>
    ),
    sortable: true,
    width: "6rem",
  },
  {
    id: "lastSample",
    label: "Last sample",
    type: "date",
    value: (p) => new Date(p.latest.sampledAt),
    cell: (p) => (
      <Text variant="caption" tone="muted">
        <RelativeTime date={new Date(p.latest.sampledAt)} />
      </Text>
    ),
    sortable: true,
    width: "6rem",
  },
];

function rendererSpecs(renderers: readonly RendererSeries[]): SeriesSpec[] {
  return renderers.map((r) => ({
    key: String(r.pid),
    label: `pid ${r.pid}`,
    points: r.points.map((p) => ({ t: p.t, v: p.memMb })),
    emphasis: false,
  }));
}

/** Page lines drawn at once: the largest heaps, plus the selected page. */
const MAX_PAGE_LINES = 8;

function pageSpecs(
  pages: readonly PageSeries[],
  selected: string | null,
): SeriesSpec[] {
  const withHeap = pages.filter((p) => p.latest.jsHeapUsedMb !== null);
  const largest = [...withHeap]
    .sort((a, b) => b.latest.jsHeapUsedMb! - a.latest.jsHeapUsedMb!)
    .slice(0, MAX_PAGE_LINES);
  const sel = withHeap.find((p) => p.pageId === selected);
  const shown =
    sel === undefined || largest.includes(sel) ? largest : [...largest, sel];
  return shown.map((p) => ({
    key: p.pageId,
    label: pageLabel(p.latest),
    points: p.points.map((pt) => ({ t: pt.t, v: pt.jsHeapUsedMb })),
    emphasis: p.pageId === selected,
  }));
}

/** The selected page's in-app tabs at its latest sample — what it held mounted. */
function SelectedPage({ page }: { page: PageSeries }): ReactElement {
  const s = page.latest;
  return (
    <Stack gap="xs">
      <SectionLabel>{pageLabel(s)}</SectionLabel>
      <Text variant="caption" tone="muted">
        Open in-app tabs:{" "}
        {s.inAppTabs.length === 0
          ? "none"
          : s.inAppTabs
              .map((t) => `${t.focused ? "▸ " : ""}${t.path}`)
              .join(" · ")}
      </Text>
      <Text variant="caption" tone="muted">
        {s.visible ? "Visible" : "Hidden"} at its last sample · JS heap total{" "}
        {s.jsHeapTotalMb === null ? "n/a" : fmtMb(s.jsHeapTotalMb)} ·{" "}
        {s.canvases} canvases ({fmtMb(s.canvasMb)}) · images {fmtMb(s.imagesMb)}{" "}
        · {s.iframes} iframes · {s.media} media
      </Text>
    </Stack>
  );
}

export function TabMemoryPanel(): ReactElement {
  const result = useLive(tabMemorySeries);
  const [selected, setSelected] = useState<string | null>(null);

  if (result.status === "error") {
    return (
      <Inset pad="lg">
        <ResourceErrorInline
          variant="block"
          subject="tab memory samples"
          error={result.error}
          refetch={result.refetch}
        />
      </Inset>
    );
  }
  if (result.status === "loading") {
    return (
      <Inset pad="lg">
        <Placeholder>Loading…</Placeholder>
      </Inset>
    );
  }
  const data = result.data;
  const domain: [number, number] = [
    data.readAtMs - data.windowMs,
    data.readAtMs,
  ];
  const selectedPage = data.pages.find((p) => p.pageId === selected);

  return (
    <Inset pad="lg">
      <Stack gap="xl">
        <Stack gap="sm">
          <SectionLabel>Chrome renderers — footprint, last 12 h</SectionLabel>
          <Text variant="caption" tone="muted">
            Your Chrome's renderer processes among the machine's largest, by pid
            (main's health-owners log, every 30 s). A climbing line is the
            process to name; find the page climbing with it below.
          </Text>
          <SeriesChart
            series={rendererSpecs(data.renderers)}
            domain={domain}
            format={fmtMb}
            emptyText="No renderer readings with a pid yet."
          />
        </Stack>
        <Stack gap="sm">
          <SectionLabel>
            Pages — JS heap (the {MAX_PAGE_LINES} largest, and the selected one)
          </SectionLabel>
          <Text variant="caption" tone="muted">
            Each page (one load of one browser tab) samples itself every 5
            minutes. Chrome refreshes the JS heap figure only about every 20
            minutes; DOM nodes, canvases and images are exact. A renderer that
            climbs while no page's heap does is growing natively — then the
            pages alive through the climb, and what they held open, are the
            candidates.
          </Text>
          <SeriesChart
            series={pageSpecs(data.pages, selected)}
            domain={domain}
            format={fmtMb}
            emptyText="No page has sampled itself yet (the first sample is 30 s after a page loads)."
          />
        </Stack>
        {selectedPage !== undefined && <SelectedPage page={selectedPage} />}
        <DataView<PageSeries>
          storageKey={PAGES_VIEW}
          rows={data.pages}
          readiness={result}
          rowKey={(p) => p.pageId}
          searchAccessor={(p) =>
            `${pageLabel(p.latest)} ${p.worktree} ${heldApps(p.latest)}`
          }
          fields={fields}
          views={["table", "list"]}
          density="compact"
          selectedRowId={selected ?? undefined}
          onRowActivate={(p) =>
            setSelected((cur) => (cur === p.pageId ? null : p.pageId))
          }
          emptyState="No page sampled itself in the last 12 h."
        />
      </Stack>
    </Inset>
  );
}
