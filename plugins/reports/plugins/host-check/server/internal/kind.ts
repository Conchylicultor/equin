import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  HOST_CHECK_KIND,
  HostCheckPayloadSchema,
  hostCheckFingerprint,
} from "../../core";
import { renderHostCheckTask } from "./render";

// Re-alert the bell at most once per 6 h per row. The audit runs hourly, and a
// stray directory on the machine is a chore for someone, not an outage.
const NOTIF_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** The `host-check` report kind — see this plugin's CLAUDE.md. */
export const hostCheckKind = ReportKind({
  kind: HOST_CHECK_KIND,
  schema: HostCheckPayloadSchema,
  fingerprint: hostCheckFingerprint,
  meta: {
    tag: "[host-check]",
    notif: "A host check failed",
    variant: "warning",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) =>
    renderHostCheckTask(row, HostCheckPayloadSchema.parse(row.data)),
});
