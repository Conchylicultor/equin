import { LiveChart } from "@plugins/stats/plugins/commits/web";
import { useLive } from "@plugins/network/plugins/live/web";
import { costDaily, type CostDay } from "../../shared/values";
import { costTotals, type CostTotals } from "../../shared/derive";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ScopeToggle } from "./scope-toggle";
import { useScope } from "./use-scope";
import { useUtcDay } from "./use-utc-day";
import { formatTokensCompact, formatUsd } from "../../core";

export function CostKpis() {
  const { scope } = useScope();
  // The same tuple as the daily charts: the totals are derived from its days.
  const daily = useLive(costDaily, { scope });
  return (
    <Stack gap="lg">
      <Stack direction="row" align="center" justify="between" gap="none">
        <Text as="p" variant="caption" className="text-muted-foreground">
          Parsed from <code>~/.claude/projects</code> and the permanent archive;
          updates as transcripts are written.
        </Text>
        <ScopeToggle />
      </Stack>
      <LiveChart
        read={daily}
        subject="the cost totals"
        size="content"
        isEmpty={(d) => d.sessionCount === 0}
        emptyText="No sessions recorded yet."
      >
        {(d) => <KpiGrid days={d.days} sessionCount={d.sessionCount} />}
      </LiveChart>
    </Stack>
  );
}

function KpiGrid({
  days,
  sessionCount,
}: {
  days: readonly CostDay[];
  sessionCount: number;
}) {
  // "The last 7 days" counts back from today (UTC, as the days are keyed),
  // moving at each UTC midnight while the card stays open.
  const today = useUtcDay();
  const totals: CostTotals = costTotals(days, new Date(today));
  return (
    // eslint-disable-next-line layout/no-adhoc-layout -- responsive col-count KPI grid (2-up → 4-up at the sm breakpoint); a fixed breakpoint count the Grid minCellWidth/cols surface deliberately doesn't express
    <div className="grid grid-cols-2 gap-md sm:grid-cols-4">
      <Kpi label="Total spent" value={formatUsd(totals.totalCost)} />
      <Kpi
        label="Total tokens"
        value={formatTokensCompact(totals.totalTokens)}
        sub={`${sessionCount} sessions`}
      />
      <Kpi
        label="Last 7 days"
        value={formatUsd(totals.last7Cost)}
        sub="rolling"
      />
      <Kpi
        label="Avg / active day"
        value={formatUsd(totals.avgDailyCost)}
        sub={`${totals.activeDays} days`}
      />
      <Kpi
        label="Input tokens"
        value={formatTokensCompact(totals.byTokenKind.input)}
        muted
      />
      <Kpi
        label="Output tokens"
        value={formatTokensCompact(totals.byTokenKind.output)}
        muted
      />
      <Kpi
        label="Cache creation"
        value={formatTokensCompact(totals.byTokenKind.cacheCreation)}
        muted
      />
      <Kpi
        label="Cache read"
        value={formatTokensCompact(totals.byTokenKind.cacheRead)}
        muted
      />
    </div>
  );
}

function Kpi({
  label,
  value,
  sub,
  muted,
}: {
  label: string;
  value: string;
  sub?: string;
  muted?: boolean;
}) {
  return (
    <div className="rounded-md border bg-background p-md">
      <Text as="div" variant="caption" className="text-muted-foreground">
        {label}
      </Text>
      <Text
        as="div"
        variant={muted ? "subheading" : "title"}
        // eslint-disable-next-line spacing/no-adhoc-spacing -- one-off label→value offset inside the KPI card; restructuring into a Stack would also add spacing before the optional sub-label
        className={
          muted ? "mt-1 font-medium text-foreground" : "mt-1 text-foreground"
        }
      >
        {value}
      </Text>
      {sub && (
        <Text as="div" variant="caption" className="text-muted-foreground">
          {sub}
        </Text>
      )}
    </div>
  );
}
