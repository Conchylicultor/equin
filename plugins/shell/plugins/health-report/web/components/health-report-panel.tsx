import { PluginErrorBoundary } from "@plugins/primitives/plugins/error-boundary/web";
import { Line } from "@plugins/primitives/plugins/css/plugins/line/web";
import { Fill } from "@plugins/primitives/plugins/css/plugins/fill/web";
import { Stack } from "@plugins/primitives/plugins/css/plugins/spacing/web";
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

/** A row with nothing beyond its summary — what `foldQuietRows` may fold. */
function isPlain(row: SealedRow): boolean {
  return (
    row.kind === "status" &&
    row.glance === undefined &&
    row.component === undefined &&
    row.actions === undefined
  );
}

/** One row in its own boundary, so a crashing contributor leaves the rest readable. */
function BoundaryRow({
  row,
  statuses,
}: {
  row: SealedRow;
  statuses: Readonly<Record<string, ReportedStatus>>;
}) {
  return (
    <PluginErrorBoundary
      slot={HealthReport.Row.id}
      label={row._pluginId ?? row.id}
    >
      {row.kind === "status" ? (
        <StatusRowView row={row} status={statuses[row.id]} />
      ) : (
        <InfoRowView row={row} useInfo={row.useInfo} />
      )}
    </PluginErrorBoundary>
  );
}

/**
 * The report: a header with the merged dot and the verdict, then every row in
 * a fixed order — info rows first, then status rows, each by `order`, never by
 * status — with the plain rows that are fine folded into one expandable card
 * at the end (`foldQuietRows`). No footer:
 * a row that has a pane to point at does so through its own `actions`, so the
 * report never names a contributor.
 *
 * Mounted only while the popover is open, which is what keeps an info row's
 * `useInfo` from running while nobody is looking.
 */
export function HealthReportPanel() {
  const rows = HealthReport.Row.useContributions();
  const statuses = HealthStore.useStore();
  const statusList = rows.flatMap((row) =>
    row.kind === "status" ? [statuses[row.id]] : [],
  );
  const merged = mergeHealth(statusList);
  const verdict = verdictOf(statusList);
  const statusOf = (row: SealedRow) =>
    row.kind === "status" ? statuses[row.id] : undefined;
  const items = foldQuietRows(sortRows(rows), statusOf, isPlain);

  return (
    <>
      <Line className="gap-sm border-b px-md py-sm">
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
      {items.length > 0 ? (
        <Stack gap="2xs" className="p-xs">
          {/* Not a DataView: these are the report's own rows — slot
              contributions, a handful at most — in an order the report
              decides, inside a transient popover. */}
          {items.map((item) =>
            item.kind === "row" ? (
              <BoundaryRow
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
                  <BoundaryRow key={row.id} row={row} statuses={statuses} />
                ))}
              </QuietRowsView>
            ),
          )}
        </Stack>
      ) : null}
    </>
  );
}
