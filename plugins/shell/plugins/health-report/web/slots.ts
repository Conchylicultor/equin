import { defineRenderSlot } from "@plugins/primitives/plugins/slot-render/web";
import type { HealthReportRow } from "../core";

/**
 * The health report's one extension point.
 *
 * A render slot: the rows are drawn, so their order is the slot's reorder
 * layout (`config/shell/health-report/shell.health-report.row.jsonc`), never a
 * number on the row. The report reads it with `useSlotOrder` and draws the rows
 * itself — info rows first, the quiet ones folded into one card — each inside
 * the slot's item middlewares (`renderAsContribution`), so a crash or an
 * element pick on a row names its contributor.
 *
 * ```ts
 * HealthReport.Row({
 *   kind: "status",
 *   id: "connection",
 *   title: "Connection",
 *   useStatus: useConnectionHealth,
 * })
 * ```
 */
export const HealthReport = {
  Row: defineRenderSlot<HealthReportRow>({
    docLabel: (row) => (row.kind === "status" ? row.title : row.id),
  }),
};
