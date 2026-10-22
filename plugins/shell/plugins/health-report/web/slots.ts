import { defineSlot } from "@plugins/framework/plugins/web-sdk/core";
import type { HealthReportRow } from "../core";

/**
 * The health report's one extension point.
 *
 * A PLAIN `defineSlot`, not a render slot, on purpose: the report owns the row
 * order (info rows first, then status rows, each by `order`), so
 * reorder middleware would only fight it, and a render slot would owe a reorder
 * config for an order no user curates. Precedent: `DataViewSlots.Control`.
 *
 * ```ts
 * HealthReport.Row({
 *   kind: "status",
 *   id: "connection",
 *   title: "Connection",
 *   order: 10,
 *   useStatus: useConnectionHealth,
 * })
 * ```
 */
export const HealthReport = {
  Row: defineSlot<HealthReportRow>({
    docLabel: (row) => (row.kind === "status" ? row.title : row.id),
  }),
};
