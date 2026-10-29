import { useState, type ReactNode } from "react";
import {
  reportSourceFor,
  type AnalyticsQuery,
  type AnalyticsReport,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import {
  SiteCard,
  SiteCardBody,
  useSiteTabLink,
  type SiteProps,
} from "@plugins/apps/plugins/deploy/plugins/deployments/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Button } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { linkProps } from "@plugins/primitives/plugins/link-gesture/web";
import { ResourceErrorInline } from "@plugins/primitives/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { kpiById, type KpiId } from "../internal/kpis";
import { PANELS } from "../internal/panels";
import { useShipsAnalytics } from "../internal/use-analytics-available";
import { deploymentAnalytics } from "../../core";
import { KpiTiles } from "./kpi-tiles";
import { RankedList } from "./ranked-panel";
import { ResultState } from "./result-states";
import { TrendChart } from "./trend-chart";

const chevronIcon = symbol("chevron-right");

/**
 * THE question the Overview asks: the Analytics tab's own opening one (30 days,
 * compared to the previous 30, unfiltered), so the Overview's three cards and
 * the tab share ONE snapshot — each measure is an SSH session to the box.
 */
const OVERVIEW_QUERY: AnalyticsQuery = {
  range: "30d",
  compare: true,
  filters: [],
};

const NO_FILTERS: AnalyticsQuery["filters"] = [];

function ignore(): void {}

/** The card header's link to the Analytics tab. */
function OpenAnalytics(): ReactNode {
  const link = useSiteTabLink("analytics");
  return (
    <Button variant="ghost" {...linkProps(link)}>
      Open analytics
      <Icon icon={chevronIcon} />
    </Button>
  );
}

/**
 * Gates an Overview analytics card the way the tab is gated (absent when the
 * composition ships no collector) and reads the shared report. Every way the
 * read can fail renders in the card's place, through the tab's own states.
 */
function ReportGate({
  deployment,
  title,
  children,
}: {
  deployment: SiteProps["deployment"];
  title: string;
  children: (report: AnalyticsReport) => ReactNode;
}): ReactNode {
  const ships = useShipsAnalytics(deployment.id);
  switch (ships.kind) {
    case "no":
      return null;
    case "pending":
      return (
        <SiteCard title={title}>
          <SiteCardBody>
            <Loading variant="rows" count={3} />
          </SiteCardBody>
        </SiteCard>
      );
    case "failed":
      return (
        <SiteCard title={title}>
          <SiteCardBody>
            <ResourceErrorInline
              variant="block"
              subject="whether this site ships analytics"
              error={ships.error}
              refetch={ships.refetch}
            />
          </SiteCardBody>
        </SiteCard>
      );
    case "yes":
      return (
        <LoadedReport deploymentId={deployment.id} title={title}>
          {children}
        </LoadedReport>
      );
  }
}

function LoadedReport({
  deploymentId,
  title,
  children,
}: {
  deploymentId: string;
  title: string;
  children: (report: AnalyticsReport) => ReactNode;
}): ReactNode {
  const answer = useLive(deploymentAnalytics, {
    deploymentId,
    query: OVERVIEW_QUERY,
  });
  if (answer.status === "ready" && answer.data.kind === "report") {
    return children(answer.data.report);
  }
  return (
    <SiteCard title={title} trailing={<OpenAnalytics />}>
      <SiteCardBody>
        {answer.status === "loading" ? (
          <Loading variant="rows" count={3} />
        ) : answer.status === "error" ? (
          <ResourceErrorInline
            variant="block"
            subject="this site's analytics"
            error={answer.error}
            refetch={answer.refresh}
          />
        ) : answer.data.kind === "report" ? null : (
          <ResultState
            result={answer.data}
            filters={NO_FILTERS}
            onKeepFirstFilter={ignore}
          />
        )}
      </SiteCardBody>
    </SiteCard>
  );
}

/** **Traffic** — the KPI tiles and the chosen metric's trend over the last 30 days. */
export function TrafficCard({ deployment }: SiteProps): ReactNode {
  return (
    <ReportGate deployment={deployment} title="Traffic">
      {(report) => <TrafficBody report={report} />}
    </ReportGate>
  );
}

/**
 * The Overview's at-a-glance four (the prototype's Traffic card); the Analytics
 * tab draws every KPI.
 */
const OVERVIEW_KPIS: readonly KpiId[] = [
  "visitors",
  "pageviews",
  "bounceRate",
  "duration",
];

function TrafficBody({ report }: { report: AnalyticsReport }): ReactNode {
  const [metric, setMetric] = useState<KpiId>("visitors");
  return (
    <SiteCard
      title="Traffic"
      meta="Last 30 days vs previous"
      trailing={<OpenAnalytics />}
    >
      <SiteCardBody>
        <Stack gap="md">
          <KpiTiles
            report={report}
            selected={metric}
            onSelect={setMetric}
            only={OVERVIEW_KPIS}
          />
          <TrendChart report={report} kpi={kpiById(metric)} />
        </Stack>
      </SiteCardBody>
    </SiteCard>
  );
}

const TOP_ROWS = 5;

/**
 * **Top pages** and **Top sources** — the first rows of the report's page and
 * channel rankings, side by side. A row opens the Analytics tab; nothing here
 * filters.
 */
export function TopCards({ deployment }: SiteProps): ReactNode {
  return (
    <ReportGate deployment={deployment} title="Top pages">
      {(report) => <TopBody report={report} />}
    </ReportGate>
  );
}

function TopBody({ report }: { report: AnalyticsReport }): ReactNode {
  const link = useSiteTabLink("analytics");
  const source = reportSourceFor(OVERVIEW_QUERY, new Date());
  const excerpt = {
    limit: TOP_ROWS,
    openTitle: "Open in analytics",
  };
  const panels = [
    { title: "Top pages", panel: "pages", tab: "top" },
    { title: "Top sources", panel: "sources", tab: "channels" },
  ].map(({ title, panel, tab }) => {
    const def = PANELS.find((p) => p.id === panel)!;
    return {
      title,
      tab: def.tabs.find((t) => t.id === tab)!,
    };
  });
  return (
    <Grid minCellWidth="18rem" gap="md" align="start">
      {panels.map(({ title, tab }) => (
        <SiteCard key={title} title={title}>
          <SiteCardBody>
            <RankedList
              tab={tab}
              report={report}
              source={source}
              filters={NO_FILTERS}
              onFilterRow={() => link.open()}
              excerpt={excerpt}
            />
          </SiteCardBody>
        </SiteCard>
      ))}
    </Grid>
  );
}
