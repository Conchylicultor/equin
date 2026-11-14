import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  CHECK_THREAD_STALL_KIND,
  CheckThreadStallPayloadSchema,
  checkThreadStallFingerprint,
} from "../../core";
import { renderCheckThreadStallTask } from "./render";

// Re-alert the bell at most once per 6 h per row. A slow check is a chronic
// cost every pass pays, not an outage — the row's count says how often.
const NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** The `check-thread-stall` report kind — see this plugin's CLAUDE.md. */
export const checkThreadStallKind = ReportKind({
  kind: CHECK_THREAD_STALL_KIND,
  schema: CheckThreadStallPayloadSchema,
  fingerprint: checkThreadStallFingerprint,
  meta: {
    tag: "[check-thread]",
    notif: "A check run stalled its thread",
    variant: "warning",
    category: "slow-op",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) =>
    renderCheckThreadStallTask(
      row,
      CheckThreadStallPayloadSchema.parse(row.data),
    ),
});
