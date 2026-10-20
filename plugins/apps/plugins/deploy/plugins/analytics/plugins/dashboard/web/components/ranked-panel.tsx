import { Fragment, useState, type ReactNode } from "react";
import type {
  AnalyticsFilter,
  AnalyticsReport,
  Dimension,
  ReportRow,
  ReportSource,
} from "@plugins/apps/plugins/deploy/plugins/analytics/plugins/collect/core";
import { Card } from "@plugins/primitives/plugins/css/plugins/card/web";
import {
  Placed,
  pct,
} from "@plugins/primitives/plugins/css/plugins/coords/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { FoldMotion } from "@plugins/primitives/plugins/collapsible/web";
import { Rigid } from "@plugins/primitives/plugins/css/plugins/rigid/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { IconButton } from "@plugins/primitives/plugins/icon-button/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { Placeholder } from "@plugins/primitives/plugins/css/plugins/placeholder/web";
import { Row } from "@plugins/primitives/plugins/css/plugins/row/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { SegmentedControl } from "@plugins/primitives/plugins/css/plugins/toggle-chip/web";
import { clickRow, isFilterOn } from "../internal/filters";
import { dimensionValueLabel, formatCount } from "../internal/format";
import type { DataCredit, PanelDef, PanelTab } from "../internal/panels";

const NUMBER_CELL = "w-24 text-right tabular-nums";
/** How far a breakdown row's label sits in from its parent's. */
const NESTED_INDENT_PX = 24;
const chevronRightIcon = symbol("chevron-right");
const expandMoreIcon = symbol("expand-more");

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
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const rows = report.rows[tab.dimension];
  if (rows.length === 0) {
    return <Placeholder>Nothing recorded in this period.</Placeholder>;
  }
  const max = Math.max(1, ...rows.map((r) => tab.primary.value(r)));
  const toggle = (value: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(value)) next.add(value);
      return next;
    });
  const rowProps = { tab, report, source, filters, onFilterRow };
  const list = (
    <Stack gap="none">
      <Line className="px-sm">
        {tab.breakdown && <ExpanderCell />}
        <Fill>
          <Text variant="eyebrow" tone="muted">
            {tab.label}
          </Text>
        </Fill>
        <Text variant="eyebrow" tone="muted" className={NUMBER_CELL}>
          {tab.primary.label}
        </Text>
        {tab.columns.map((c) => (
          <Text
            key={c.label}
            variant="eyebrow"
            tone="muted"
            className={NUMBER_CELL}
          >
            {c.label}
          </Text>
        ))}
      </Line>
      {rows.map((row) => {
        const groups = tab.breakdown?.(row, report) ?? [];
        const open = expanded.has(row.value);
        const label = dimensionValueLabel(tab.dimension, row.value);
        return (
          <Fragment key={row.value}>
            <Line>
              {tab.breakdown && (
                <ExpanderCell>
                  {groups.length > 0 && (
                    <IconButton
                      icon={open ? expandMoreIcon : chevronRightIcon}
                      label={`${open ? "Collapse" : "Expand"} ${label}`}
                      aria-expanded={open}
                      onClick={() => toggle(row.value)}
                    />
                  )}
                </ExpanderCell>
              )}
              <Fill>
                <RankedRow
                  {...rowProps}
                  dimension={tab.dimension}
                  row={row}
                  label={label}
                  share={tab.primary.value(row) / max}
                />
              </Fill>
            </Line>
            <FoldMotion open={open}>
              {groups.map((group) => (
                <Fragment key={group.label}>
                  <Line className="px-sm">
                    <ExpanderCell />
                    <Text
                      variant="eyebrow"
                      tone="muted"
                      style={{ paddingLeft: NESTED_INDENT_PX }}
                    >
                      {group.label}
                    </Text>
                  </Line>
                  {group.rows.map((sub) => (
                    <Line key={sub.value}>
                      <ExpanderCell />
                      <Fill>
                        <RankedRow
                          {...rowProps}
                          dimension={group.dimension}
                          row={sub}
                          label={group.rowLabel(sub.value)}
                          // relative to the parent: the share of its count this value holds
                          share={
                            tab.primary.value(sub) /
                            Math.max(1, tab.primary.value(row))
                          }
                          nested
                        />
                      </Fill>
                    </Line>
                  ))}
                </Fragment>
              ))}
            </FoldMotion>
          </Fragment>
        );
      })}
    </Stack>
  );
  // An expander is an xs icon button; its column is that box wide on every line.
  return tab.breakdown ? (
    <ControlSizeProvider size="xs">{list}</ControlSizeProvider>
  ) : (
    list
  );
}

/** The leading column of a list whose rows expand: the expander, or the empty box that keeps the rows aligned. */
function ExpanderCell({ children }: { children?: ReactNode }): ReactNode {
  return <Rigid className="control-icon-xs">{children}</Rigid>;
}

/** One ranked row: a filter toggle for its (dimension, value), its bar, and its numbers. */
function RankedRow({
  tab,
  report,
  source,
  filters,
  onFilterRow,
  dimension,
  row,
  label,
  share,
  nested,
}: {
  tab: PanelTab;
  report: AnalyticsReport;
  source: ReportSource;
  filters: readonly AnalyticsFilter[];
  onFilterRow: (dimension: Dimension, value: string) => void;
  dimension: Dimension;
  row: ReportRow;
  label: string;
  /** The bar's length, 0–1. */
  share: number;
  /** A breakdown row, indented under its parent. */
  nested?: true;
}): ReactNode {
  const selected = isFilterOn(filters, dimension, row.value);
  const click = clickRow(filters, source, dimension, row.value);
  return (
    <Row
      selected={selected}
      disabled={click.kind === "blocked"}
      title={
        click.kind === "blocked"
          ? click.reason
          : selected
            ? "Remove this filter"
            : `Filter by ${label}`
      }
      onClick={() => onFilterRow(dimension, row.value)}
      indent={nested ? NESTED_INDENT_PX : undefined}
      className="relative"
    >
      <Placed
        as="span"
        decorative
        x={{ start: 0, size: pct(share) }}
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
      {tab.columns.map((c) => (
        <Text key={c.label} tone="muted" className={`relative ${NUMBER_CELL}`}>
          {c.cell(row, report)}
        </Text>
      ))}
    </Row>
  );
}
