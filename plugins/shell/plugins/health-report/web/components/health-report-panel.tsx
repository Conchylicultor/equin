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
  mergeDot,
  sortRows,
  verdictOf,
  type HealthReportRow,
  type ReportedStatus,
} from "../../core";
import { HealthReport } from "../slots";
import {
  HealthStore,
  reportedStatusesOf,
  setItemId,
  type HealthReportState,
} from "../internal/store";
import { HealthDot } from "./health-dot";
import {
  InfoRowView,
  isPlainLine,
  QuietRowsView,
  StatusRowView,
  type StatusLine,
} from "./health-row";

type SealedRow = SealContributions<HealthReportRow>;
type SealedInfoRow = Extract<SealedRow, { kind: "info" }>;

/**
 * One line of the report, as `sortRows` / `foldQuietRows` arrange it: an info
 * row, or a status line — a row set already expanded into its items, so the
 * fold treats each item as an ordinary row.
 */
type ReportLine =
  | { kind: "info"; id: string; row: SealedInfoRow }
  | { kind: "status"; id: string; line: StatusLine };

function statusLine(line: StatusLine): ReportLine {
  return { kind: "status", id: line.id, line };
}

/** The report's lines, in the order the rows are given: each row set where it sits, as its items. */
function linesOf(
  rows: readonly SealedRow[],
  state: HealthReportState,
): ReportLine[] {
  return rows.flatMap((row): ReportLine[] => {
    switch (row.kind) {
      case "info":
        return [{ kind: "info", id: row.id, row }];
      case "status":
        return [statusLine({ kind: "status", id: row.id, row })];
      case "set": {
        const items = state.sets[row.id];
        if (items === undefined)
          return [statusLine({ kind: "set-placeholder", id: row.id, row })];
        return items.map((item) =>
          statusLine({
            kind: "set-item",
            id: setItemId(row.id, item.key),
            row,
            rowKey: item.key,
            title: item.title,
          }),
        );
      }
    }
  });
}

/**
 * One row, drawn by the report but rendered AS its contribution: inside the
 * slot's item middlewares and box (`renderAsContribution`) — so a crashing
 * contributor leaves the rest readable, and an element pick on the row names
 * the plugin that contributed it rather than the report.
 */
function ContributedRow({
  line,
  statuses,
}: {
  line: ReportLine;
  statuses: Readonly<Record<string, ReportedStatus>>;
}) {
  return line.kind === "status"
    ? renderAsContribution(
        HealthReport.Row,
        line.line.row,
        <StatusRowView line={line.line} status={statuses[line.id]} />,
      )
    : renderAsContribution(
        HealthReport.Row,
        line.row,
        <InfoRowView row={line.row} useInfo={line.row.useInfo} />,
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
  const state = HealthStore.useStore();
  const rows =
    order.status === "ready"
      ? order.data
      : order.status === "error"
        ? order.stale
        : undefined;
  const statusList =
    rows === undefined
      ? Object.values(state.statuses)
      : rows.flatMap((row) =>
          row.kind === "info" ? [] : reportedStatusesOf(state, row),
        );
  // The same dot as the action bar's: an ambient row (the machine busy) is
  // shown as it is in its own row and named by the verdict, but never
  // colours the dot — here or in the bar.
  const merged = mergeDot(statusList);
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
  const state = HealthStore.useStore();
  const { statuses } = state;
  const statusOf = (line: ReportLine) =>
    line.kind === "status" ? statuses[line.id] : undefined;
  const isPlain = (line: ReportLine) =>
    line.kind === "status" && isPlainLine(line.line);
  // An `absent` row has nothing to say here: it is not drawn at all.
  const shown = linesOf(rows, state).filter(
    (line) => statusOf(line)?.state !== "absent",
  );
  const items = foldQuietRows(sortRows(shown), statusOf, isPlain);

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
                line={item.row}
                statuses={statuses}
              />
            ) : (
              <QuietRowsView
                key="quiet"
                lines={item.rows.flatMap((line) =>
                  line.kind === "status" ? [line.line] : [],
                )}
                statuses={statuses}
              >
                {item.rows.map((line) => (
                  <ContributedRow
                    key={line.id}
                    line={line}
                    statuses={statuses}
                  />
                ))}
              </QuietRowsView>
            ),
          )}
        </Stack>
      ) : null}
    </>
  );
}
