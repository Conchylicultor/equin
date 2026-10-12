import type { ReactNode } from "react";
import { appLink } from "@plugins/apps-core/plugins/tabs/web";
import { activationProps } from "@plugins/primitives/plugins/link-gesture/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { formatValue } from "@plugins/primitives/plugins/metrics/plugins/chart-kit/core";
import { ChartState } from "@plugins/primitives/plugins/metrics/plugins/chart-kit/web";
import type { BreakdownResult, CatalogBreakdown } from "../../core";
import { breakdownQuery, type BoardContext } from "../internal/query";
import { useMetric } from "../internal/use-metric";
import { CardFrame } from "./card-frame";
import { CARD_CHART_HEIGHT, matchChart } from "./chart-resource";

export interface BreakdownCardProps {
  entry: CatalogBreakdown;
  context: BoardContext;
}

/** A breakdown as a card: its ranked rows over the range, each a link when it has one. */
export function BreakdownCard({
  entry,
  context,
}: BreakdownCardProps): ReactNode {
  const result = useMetric(breakdownQuery(entry, context));
  return (
    <CardFrame title={entry.label} data-metric-card={entry.id}>
      {matchChart(result, entry.label.toLowerCase(), (data) =>
        data.kind === "breakdown" ? (
          <BreakdownRows entry={entry} data={data} />
        ) : (
          <ChartState
            state="error"
            height={CARD_CHART_HEIGHT}
            message={`"${entry.id}" answered a series, not a breakdown`}
          />
        ),
      )}
    </CardFrame>
  );
}

function BreakdownRows({
  entry,
  data,
}: {
  entry: CatalogBreakdown;
  data: BreakdownResult;
}): ReactNode {
  if (data.rows.length === 0) {
    return <ChartState state="empty" height={CARD_CHART_HEIGHT} />;
  }
  return (
    <Stack gap="none">
      {/* eslint-disable-next-line data-view/no-adhoc-row-list -- a breakdown's ranked aggregate rows (computed, read-only, bounded by the provider), not a collection of domain records to search or filter */}
      {data.rows.map((row) => (
        <Row
          key={row.key}
          {...activationProps(
            row.link === undefined ? undefined : appLink(row.link.href),
          )}
        >
          <Fill>
            <Text>{row.label}</Text>
          </Fill>
          <Text tone="subtle" className="tabular-nums">
            {formatValue(entry.unit, row.value)}
          </Text>
        </Row>
      ))}
    </Stack>
  );
}
