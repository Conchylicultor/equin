import type { ReactNode } from "react";
import type { AnalyticsReport } from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import { Grid } from "@plugins/primitives/plugins/css/plugins/grid/web";
import { Inline } from "@plugins/primitives/plugins/css/plugins/inline/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { formatPercent, orDash } from "../internal/format";
import { KPIS, kpiChange, type KpiId } from "../internal/kpis";

/**
 * One tile per KPI: the current period's value and, when compared, its change.
 * The tiles are the chart's metric picker — the selected one is what the line
 * draws.
 */
export function KpiTiles({
  report,
  selected,
  onSelect,
  only,
}: {
  report: AnalyticsReport;
  selected: KpiId;
  onSelect: (id: KpiId) => void;
  /** The subset to draw, in `KPIS` order (the Overview's four); absent ⇒ every KPI. */
  only?: readonly KpiId[];
}): ReactNode {
  const kpis = only ? KPIS.filter((k) => only.includes(k.id)) : KPIS;
  return (
    <Grid
      minCellWidth="9rem"
      mode="fit"
      gap="sm"
      role="radiogroup"
      aria-label="Chart metric"
    >
      {kpis.map((kpi) => {
        const change = report.previous
          ? kpiChange(kpi, report.current.summary, report.previous.summary)
          : null;
        return (
          <Card
            key={kpi.id}
            as="button"
            type="button"
            role="radio"
            aria-checked={kpi.id === selected}
            interactive
            selected={kpi.id === selected}
            onClick={() => onSelect(kpi.id)}
            className="text-left"
          >
            <Stack gap="2xs">
              <Text
                variant="caption"
                tone={kpi.id === selected ? "default" : "muted"}
              >
                {kpi.label}
              </Text>
              <Inline gap="xs" align="baseline">
                <Text variant="heading" className="tabular-nums">
                  {orDash(kpi.value(report.current.summary), kpi.format)}
                </Text>
                {report.previous && <ChangeLabel change={change} />}
              </Inline>
            </Stack>
          </Card>
        );
      })}
    </Grid>
  );
}

function ChangeLabel({
  change,
}: {
  change: ReturnType<typeof kpiChange>;
}): ReactNode {
  if (!change) {
    return (
      <Text
        variant="caption"
        tone="muted"
        title="Nothing to compare: the previous period had none"
      >
        —
      </Text>
    );
  }
  if (change.kind === "flat") {
    return (
      <Text variant="caption" tone="muted" className="tabular-nums">
        0%
      </Text>
    );
  }
  return (
    <Text
      variant="caption"
      className={`tabular-nums ${change.good ? "text-success" : "text-destructive"}`}
      title="Change from the previous period"
    >
      {change.fraction > 0 ? "↑" : "↓"}{" "}
      {formatPercent(Math.abs(change.fraction))}
    </Text>
  );
}
