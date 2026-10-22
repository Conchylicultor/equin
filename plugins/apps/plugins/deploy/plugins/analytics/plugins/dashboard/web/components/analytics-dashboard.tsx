import { useId, useState, type ReactNode } from "react";
import {
  reportSourceFor,
  type AnalyticsFilter,
  type AnalyticsQuery,
  type AnalyticsRange,
  type AnalyticsReport,
  type Dimension,
  type ReportSource,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Cluster } from "@plugins/primitives/plugins/css/plugins/cluster/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Switch } from "@plugins/primitives/plugins/css/plugins/switch/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { RelativeTime } from "@plugins/primitives/plugins/relative-time/web";
import { clickRow, removeFilter } from "../internal/filters";
import { RANGE_OPTIONS } from "../internal/format";
import { kpiById, type KpiId } from "../internal/kpis";
import { PANELS } from "../internal/panels";
import { deploymentAnalytics } from "../../core";
import { FilterBar } from "./filter-bar";
import { KpiTiles } from "./kpi-tiles";
import { RankedPanel } from "./ranked-panel";
import { RecordedFields } from "./recorded-fields";
import { ResultState } from "./result-states";
import { TrendChart } from "./trend-chart";
import { symbol } from "@plugins/ui/plugins/icons/core";

const refreshIcon = symbol("refresh");

/** Dimensions a visitor ARRIVES through: filtering by one shows where they landed. */
const SOURCE_DIMENSIONS: ReadonlySet<Dimension> = new Set([
  "channel",
  "referrer_host",
  "referrer_path",
  "utm_campaign",
]);

/**
 * The deployed site's analytics: range and comparison, the KPI tiles and their
 * trend, ranked panels that filter the whole dashboard, and what one visit
 * records. Every change of range, comparison or filters asks the box again;
 * nothing refreshes on a timer.
 */
export function AnalyticsDashboard({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  const [range, setRange] = useState<AnalyticsRange>("30d");
  const [compare, setCompare] = useState(true);
  const [filters, setFilters] = useState<AnalyticsFilter[]>([]);
  const [metric, setMetric] = useState<KpiId>("visits");
  const [tabs, setTabs] = useState<Record<string, string>>({});
  const compareLabelId = useId();

  const query: AnalyticsQuery = { range, compare, filters };
  // Decided client-side with the same function the server uses, so a second
  // filter is disabled BEFORE asking rather than refused after.
  const source = reportSourceFor(query, new Date());
  // One snapshot per (deployment, query): every range, compare or filter
  // change is a new question; nothing re-asks on its own — each measure is an
  // SSH session to the box — so Refresh (`refresh()`) is the only re-ask.
  const answer = useLive(deploymentAnalytics, { deploymentId, query });

  const onFilterRow = (dimension: Dimension, value: string) => {
    const click = clickRow(filters, source, dimension, value);
    if (click.kind === "blocked") return;
    setFilters(click.next);
    if (click.kind !== "remove" && SOURCE_DIMENSIONS.has(dimension)) {
      setTabs((t) => ({ ...t, pages: "entry" }));
    }
  };

  return (
    <Stack gap="md">
      <Cluster gap="md" align="center">
        <SegmentedControl
          options={RANGE_OPTIONS}
          value={range}
          onChange={setRange}
        />
        <Inline gap="xs">
          <Switch
            checked={compare}
            onCheckedChange={setCompare}
            aria-labelledby={compareLabelId}
          />
          <Text id={compareLabelId} variant="control">
            Compare to previous period
          </Text>
        </Inline>
        <Inline gap="xs">
          {answer.status === "ready" && answer.data.kind === "report" && (
            <Text variant="caption" tone="muted">
              Updated{" "}
              <RelativeTime date={new Date(answer.data.report.generatedAt)} />
            </Text>
          )}
          <IconButton
            icon={refreshIcon}
            label="Refresh"
            loading={answer.status === "loading"}
            onClick={() => answer.refresh()}
          />
        </Inline>
      </Cluster>

      <FilterBar
        filters={filters}
        source={source}
        onRemove={(dimension) => setFilters((f) => removeFilter(f, dimension))}
        onClear={() => setFilters([])}
      />

      {answer.status === "loading" ? (
        <Loading variant="cards" count={6} />
      ) : answer.status === "error" ? (
        <ResourceErrorInline
          variant="block"
          subject="this deployment's analytics"
          error={answer.error}
          refetch={answer.refresh}
        />
      ) : answer.data.kind === "report" ? (
        <ReportView
          report={answer.data.report}
          source={source}
          filters={filters}
          metric={metric}
          onMetric={setMetric}
          tabs={tabs}
          onTab={(panel, tab) => setTabs((t) => ({ ...t, [panel]: tab }))}
          onFilterRow={onFilterRow}
        />
      ) : (
        <ResultState
          result={answer.data}
          filters={filters}
          onKeepFirstFilter={() => setFilters((f) => f.slice(0, 1))}
        />
      )}

      <RecordedFields />
    </Stack>
  );
}

function ReportView({
  report,
  source,
  filters,
  metric,
  onMetric,
  tabs,
  onTab,
  onFilterRow,
}: {
  report: AnalyticsReport;
  source: ReportSource;
  filters: readonly AnalyticsFilter[];
  metric: KpiId;
  onMetric: (id: KpiId) => void;
  tabs: Record<string, string>;
  onTab: (panelId: string, tabId: string) => void;
  onFilterRow: (dimension: Dimension, value: string) => void;
}): ReactNode {
  const panel = (id: string) => {
    const def = PANELS.find((p) => p.id === id)!;
    return (
      <RankedPanel
        key={def.id}
        panel={def}
        tabId={tabs[def.id] ?? def.tabs[0]!.id}
        onTab={(tab) => onTab(def.id, tab)}
        report={report}
        source={source}
        filters={filters}
        onFilterRow={onFilterRow}
      />
    );
  };
  return (
    <Stack gap="md">
      <Card>
        <Stack gap="md">
          <KpiTiles report={report} selected={metric} onSelect={onMetric} />
          <TrendChart report={report} kpi={kpiById(metric)} />
        </Stack>
      </Card>
      <Grid minCellWidth="22rem" gap="md" align="start">
        {PANELS.filter((p) => !p.wide).map((p) => panel(p.id))}
      </Grid>
      {PANELS.filter((p) => p.wide).map((p) => panel(p.id))}
    </Stack>
  );
}
