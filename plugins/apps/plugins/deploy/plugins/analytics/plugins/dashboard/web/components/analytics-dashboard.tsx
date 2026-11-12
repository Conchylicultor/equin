import { useId, useState, type ReactNode } from "react";
import {
  ANALYTICS_MIRROR_SET_ID,
  AUDIENCE_OPTIONS,
  reportSourceFor,
  type AnalyticsFilter,
  type AnalyticsQuery,
  type AnalyticsRange,
  type AnalyticsReport,
  type Audience,
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
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { clickRow, removeFilter } from "../internal/filters";
import { RANGE_OPTIONS } from "../internal/format";
import { ANALYTICS_MIRROR_SUBJECT } from "../internal/mirror";
import { kpiById, type KpiId } from "../internal/kpis";
import { PANELS } from "../internal/panels";
import { deploymentAnalytics } from "../../core";
import { FilterBar } from "./filter-bar";
import { KpiTiles } from "./kpi-tiles";
import { RankedPanel } from "./ranked-panel";
import { RecordedFields } from "./recorded-fields";
import { ResultState } from "./result-states";
import { TrendChart } from "./trend-chart";
import { MirrorFreshness } from "@plugins/apps/plugins/deploy/plugins/site-mirror/plugins/pull/web";

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
 * records. The report runs on this computer's copy of the site's tables, so
 * every change of range, comparison or filters is answered locally; it moves
 * with each page the copy syncs, and the freshness line above it says when
 * that was (Sync now asks the box for what is new).
 */
export function AnalyticsDashboard({
  deploymentId,
}: {
  deploymentId: string;
}): ReactNode {
  const [range, setRange] = useState<AnalyticsRange>("30d");
  const [compare, setCompare] = useState(true);
  const [filters, setFilters] = useState<AnalyticsFilter[]>([]);
  // Whose visits: everyone but the site's owner by default, so reading your
  // own site never inflates it (collect's `audience.ts`).
  const [audience, setAudience] = useState<Audience>("visitors");
  const [metric, setMetric] = useState<KpiId>("visits");
  const [tabs, setTabs] = useState<Record<string, string>>({});
  const compareLabelId = useId();

  const query: AnalyticsQuery = { range, compare, filters, audience };
  // Decided client-side with the same function the server uses, so a second
  // filter is disabled BEFORE asking rather than refused after.
  const source = reportSourceFor(query, new Date());
  // One pushed answer per (deployment, query): every range, compare or filter
  // change is a new question, answered from the local copy; each page the
  // copy syncs recomputes it.
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
      {/* The local copy of the site's analytics tables (site-mirror) the
          report below runs on: when it was synced, Sync now, and why a pull
          failed. Opening the tab asks for a pull when the copy is stale. */}
      <MirrorFreshness
        deploymentId={deploymentId}
        setId={ANALYTICS_MIRROR_SET_ID}
        subject={ANALYTICS_MIRROR_SUBJECT}
      />
      <Cluster gap="md" align="center">
        <SegmentedControl
          options={RANGE_OPTIONS}
          value={range}
          onChange={setRange}
        />
        <SegmentedControl
          label="Whose visits"
          options={AUDIENCE_OPTIONS}
          value={audience}
          onChange={setAudience}
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
          refetch={answer.refetch}
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
      ) : answer.data.kind === "refused" ? (
        <ResultState
          result={answer.data}
          filters={filters}
          onKeepFirstFilter={() => setFilters((f) => f.slice(0, 1))}
          onVisitorsOnly={() => setAudience("visitors")}
        />
      ) : (
        // Not copied yet is not known yet: loading, while the freshness line
        // above says how the first copy is going.
        <Loading variant="cards" count={6} />
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
