import {
  renderAsContribution,
  useSlotOrder,
} from "@plugins/primitives/plugins/slot-render/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
import { ResourceErrorInline } from "@plugins/network/plugins/live/plugins/live-state/web";
import { Loading } from "@plugins/primitives/plugins/loading/web";
import { Text } from "@plugins/primitives/plugins/css/plugins/text/web";
import { ControlSizeProvider } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import type { SealContributions } from "@plugins/framework/plugins/web-sdk/core";
import {
  foldQuietRows,
  mergeHealth,
  sortRows,
  verdictOf,
  type HealthReportRow,
  type ReportedStatus,
} from "../../core";
import { HealthReport } from "../slots";
import { HealthStore } from "../internal/store";
import { HealthDot } from "./health-dot";
import { InfoRowView, QuietRowsView, StatusRowView } from "./health-row";

type SealedRow = SealContributions<HealthReportRow>;

/**
 * A row with nothing beyond its summary — what `foldQuietRows` may fold. A
 * `remedy` does not count: it is drawn only while the row is not ok, and a
 * folded row is ok.
 */
function isPlain(row: SealedRow): boolean {
  return (
    row.kind === "status" &&
    row.glance === undefined &&
    row.component === undefined &&
    row.actions === undefined
  );
}

/**
 * One row, drawn by the report but rendered AS its contribution: inside the
 * slot's item middlewares and box (`renderAsContribution`) — so a crashing
 * contributor leaves the rest readable, and an element pick on the row names
 * the plugin that contributed it rather than the report.
 */
function ContributedRow({
  row,
  statuses,
}: {
  row: SealedRow;
  statuses: Readonly<Record<string, ReportedStatus>>;
}) {
  return renderAsContribution(
    HealthReport.Row,
    row,
    row.kind === "status" ? (
      <StatusRowView row={row} status={statuses[row.id]} />
    ) : (
      <InfoRowView row={row} useInfo={row.useInfo} />
    ),
  );
}

/**
 * The report: a header with the merged dot and the verdict, then every row in
 * a fixed order — info rows first, then status rows, each in the slot's layout
 * order, never by status — with the plain rows at the end, those that are fine
 * folded into one expandable card and the rest just above it (`foldQuietRows`).
 * No footer:
 * a row that has a pane to point at does so through its own `actions`, so the
 * report never names a contributor.
 *
 * Mounted only while the popover is open, which is what keeps an info row's
 * `useInfo` from running while nobody is looking.
 *
 * While the rows' layout order is not known yet the whole report — verdict
 * included, since it derives from the rows — is a loading state, never the
 * rows in raw registration order (which would show hidden rows and then jump).
 */
/**
 * The report's header strip — the merged dot and the verdict — drawn in the
 * popover's own `header` slot (sticky, its rule across the panel, its text on
 * the panel's text rail). Always drawn (the slot's strip is there either way):
 * over the ordered rows once their order is known, else over every status the
 * probes have published — the same set, since one probe is mounted per
 * contributed row, which is what the button's dot merges too.
 */
export function HealthReportHeader() {
  const order = useSlotOrder(HealthReport.Row);
  const statuses = HealthStore.useStore();
  const rows =
    order.status === "ready"
      ? order.data
      : order.status === "error"
        ? order.stale
        : undefined;
  const statusList =
    rows === undefined
      ? Object.values(statuses)
      : rows.flatMap((row) =>
          row.kind === "status" ? [statuses[row.id]] : [],
        );
  const merged = mergeHealth(statusList);
  const verdict = verdictOf(statusList);
  return (
    <Line className="gap-sm">
      <ControlSizeProvider size="lg">
        <HealthDot
          level={merged.state}
          pulsing={merged.pending || merged.transitioning}
        />
      </ControlSizeProvider>
      <Fill>
        <Text variant="label" className="font-semibold" title={verdict}>
          {verdict}
        </Text>
      </Fill>
    </Line>
  );
}

export function HealthReportPanel() {
  const order = useSlotOrder(HealthReport.Row);
  switch (order.status) {
    case "loading":
      return <Loading variant="rows" count={4} />;
    case "error":
      return order.stale === undefined ? (
        <ResourceErrorInline
          error={order.error}
          refetch={order.refetch}
          variant="block"
          subject="the health report"
        />
      ) : (
        <HealthReportPanelReady rows={order.stale} />
      );
    case "ready":
      return <HealthReportPanelReady rows={order.data} />;
  }
}

/** The report once its rows' order is known — see {@link HealthReportPanel}. */
function HealthReportPanelReady({ rows }: { rows: readonly SealedRow[] }) {
  const statuses = HealthStore.useStore();
  const statusOf = (row: SealedRow) =>
    row.kind === "status" ? statuses[row.id] : undefined;
  const items = foldQuietRows(sortRows(rows), statusOf, isPlain);

  return (
    <>
      {items.length > 0 ? (
        <Stack gap="2xs">
          {/* Not a DataView: these are slot contributions — a handful at
              most — in the slot's layout order, arranged by the report (info
              first, quiet rows folded), inside a transient popover. */}
          {items.map((item) =>
            item.kind === "row" ? (
              <ContributedRow
                key={item.row.id}
                row={item.row}
                statuses={statuses}
              />
            ) : (
              <QuietRowsView
                key="quiet"
                rows={item.rows.flatMap((row) =>
                  row.kind === "status" ? [row] : [],
                )}
                statuses={statuses}
              >
                {item.rows.map((row) => (
                  <ContributedRow key={row.id} row={row} statuses={statuses} />
                ))}
              </QuietRowsView>
            ),
          )}
        </Stack>
      ) : null}
    </>
  );
}
