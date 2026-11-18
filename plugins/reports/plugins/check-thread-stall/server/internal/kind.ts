import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  CHECK_PASS_HUNG_KIND,
  CHECK_THREAD_STALL_KIND,
  CheckPassHungPayloadSchema,
  CheckThreadStallPayloadSchema,
  checkPassHungFingerprint,
  checkThreadStallFingerprint,
} from "../../core";
import { renderCheckPassHungTask } from "./hung-render";
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

/**
 * The `check-pass-hung` report kind — a pass its watchdog killed. An error: a
 * build or push failed on it. No cooldown beyond the engine's own: each hang
 * is an occurrence worth the bell.
 */
export const checkPassHungKind = ReportKind({
  kind: CHECK_PASS_HUNG_KIND,
  schema: CheckPassHungPayloadSchema,
  fingerprint: checkPassHungFingerprint,
  meta: {
    tag: "[check-hung]",
    notif: "A check pass hung and was killed",
    variant: "error",
    category: "error",
  },
  renderTask: (row: ReportRow) =>
    renderCheckPassHungTask(row, CheckPassHungPayloadSchema.parse(row.data)),
});
