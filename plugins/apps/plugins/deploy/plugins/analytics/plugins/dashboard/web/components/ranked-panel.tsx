import type { ReactNode } from "react";
import type {
  AnalyticsFilter,
  AnalyticsReport,
  Dimension,
  ReportSource,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import {
  Placed,
  pct,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { clickRow, isFilterOn } from "../internal/filters";
import { dimensionValueLabel, formatCount } from "../internal/format";
import type { DataCredit, PanelDef, PanelTab } from "../internal/panels";

const NUMBER_CELL = "w-24 text-right tabular-nums";

/**
 * One panel of the dashboard: a titled card whose tabs each rank one
 * dimension's rows. Clicking a row filters the whole dashboard by its value.
 */
export function RankedPanel({
  panel,
  tabId,
  onTab,
  report,
  source,
  filters,
  onFilterRow,
}: {
  panel: PanelDef;
  tabId: string;
  onTab: (tabId: string) => void;
  report: AnalyticsReport;
  source: ReportSource;
  filters: readonly AnalyticsFilter[];
  onFilterRow: (dimension: Dimension, value: string) => void;
}): ReactNode {
  const tab = panel.tabs.find((t) => t.id === tabId) ?? panel.tabs[0]!;
  return (
    <Card>
      <Stack gap="sm">
        <Line>
          <Text as="h3" variant="subheading">
            {panel.title}
          </Text>
          <Fill />
          {panel.tabs.length > 1 && (
            <SegmentedControl
              variant="ghost"
              options={panel.tabs.map((t) => ({ id: t.id, label: t.label }))}
              value={tab.id}
              onChange={onTab}
            />
          )}
        </Line>
        <RankedList
          tab={tab}
          report={report}
          source={source}
          filters={filters}
          onFilterRow={onFilterRow}
        />
        {(tab.note || tab.credit) && (
          <Text as="p" variant="caption" tone="muted">
            {tab.note}
            {tab.note && tab.credit && " "}
            {tab.credit && <Credit credit={tab.credit} />}
          </Text>
        )}
      </Stack>
    </Card>
  );
}

/** "IP geolocation by DB-IP (db-ip.com), CC BY 4.0." — the source name links to it. */
function Credit({ credit }: { credit: DataCredit }): ReactNode {
  const { what, source } = credit;
  return (
    <>
      {what} by{" "}
      <a
        href={source.url}
        target="_blank"
        rel="noreferrer noopener"
        className="underline hover:text-foreground"
      >
        {source.name}
      </a>{" "}
      ({new URL(source.url).host}), {source.license}.
    </>
  );
}

function RankedList({
  tab,
  report,
  source,
  filters,
  onFilterRow,
}: {
  tab: PanelTab;
  report: AnalyticsReport;
  source: ReportSource;
  filters: readonly AnalyticsFilter[];
  onFilterRow: (dimension: Dimension, value: string) => void;
}): ReactNode {
  const rows = report.rows[tab.dimension];
  if (rows.length === 0) {
    return <Placeholder>Nothing recorded in this period.</Placeholder>;
  }
  const max = Math.max(1, ...rows.map((r) => tab.primary.value(r)));
  return (
    <Stack gap="none">
      <Line className="px-sm">
        <Fill>
          <Text variant="eyebrow" tone="muted">
            {tab.label}
          </Text>
        </Fill>
        <Text variant="eyebrow" tone="muted" className={NUMBER_CELL}>
          {tab.primary.label}
        </Text>
        <Text variant="eyebrow" tone="muted" className={NUMBER_CELL}>
          {tab.secondary.label}
        </Text>
      </Line>
      {/* eslint-disable-next-line data-view/no-adhoc-row-list -- a ranked top-N readout of one fetched report (not live records): each row is a filter toggle, the order is the server's ranking, and search/sort/group would contradict it */}
      {rows.map((row) => {
        const selected = isFilterOn(filters, tab.dimension, row.value);
        const click = clickRow(filters, source, tab.dimension, row.value);
        const label = dimensionValueLabel(tab.dimension, row.value);
        return (
          <Row
            key={row.value}
            selected={selected}
            disabled={click.kind === "blocked"}
            title={
              click.kind === "blocked"
                ? click.reason
                : selected
                  ? "Remove this filter"
                  : `Filter by ${label}`
            }
            onClick={() => onFilterRow(tab.dimension, row.value)}
            className="relative"
          >
            <Placed
              as="span"
              decorative
              x={{ start: 0, size: pct(tab.primary.value(row) / max) }}
              y="fill"
              className="rounded-md bg-primary/10"
            />
            {/* `relative`: positioned after the bar, so the text paints over it. */}
            <Fill className="relative">
              <Text>{label}</Text>
            </Fill>
            <Text className={`relative ${NUMBER_CELL}`}>
              {formatCount(tab.primary.value(row))}
            </Text>
            <Text tone="muted" className={`relative ${NUMBER_CELL}`}>
              {tab.secondary.cell(row, report)}
            </Text>
          </Row>
        );
      })}
    </Stack>
  );
}
