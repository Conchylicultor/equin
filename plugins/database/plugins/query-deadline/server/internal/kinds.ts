import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  DB_ABANDON_CAP_KIND,
  DB_QUERY_DEADLINE_KIND,
  DbAbandonCapPayloadSchema,
  DbQueryDeadlinePayloadSchema,
} from "../../core";
import {
  abandonCapFingerprint,
  queryDeadlineFingerprint,
  renderAbandonCapTask,
  renderQueryDeadlineTask,
} from "./render";

// Re-alert the bell at most once per 10 minutes per fingerprint. A caller
// that keeps losing calls is one ongoing problem, and 10 minutes is also the
// window the Database health row counts over, so the bell and the dot agree on
// what "recent" means.
const NOTIF_COOLDOWN_MS = 600_000;

// `duressExempt: true` on BOTH kinds. A lost query and a host in trouble are
// often the same event: the box is struggling, the sentinel latches duress, and
// the reports funnel starts shedding. Without the flag `recordReport` would
// buffer exactly the reports that describe the outage — the alarm silenced by
// the outage (Silencer 2 of the 2026-08-17 incident; the same argument
// `jobs/deadline-audit` and `queue-health`'s wedged kind make). Volume is
// bounded without the gate: a lost query costs a full deadline each, and the
// fingerprint dedupes repeats onto one row.

/**
 * The `db-query-deadline` report kind: **one query got no answer before its
 * deadline, failed its caller, and had its connection abandoned.**
 *
 * Variant `error`: unlike a job deadline (the system working as designed), the
 * normal cause here is a defect elsewhere in the process — a file handle closed
 * by code that did not own it. See the incident doc the task points at.
 */
export const queryDeadlineKind = ReportKind({
  kind: DB_QUERY_DEADLINE_KIND,
  schema: DbQueryDeadlinePayloadSchema,
  fingerprint: queryDeadlineFingerprint,
  duressExempt: true,
  meta: {
    tag: "[db]",
    notif: "A database call got no answer and was abandoned",
    variant: "error",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) =>
    renderQueryDeadlineTask(row, DbQueryDeadlinePayloadSchema.parse(row.data)),
});

/**
 * The `db-abandon-cap` report kind: **this process abandoned more connections
 * than the database plugin's hold set is sized for.** One rolling row per
 * worktree.
 */
export const abandonCapKind = ReportKind({
  kind: DB_ABANDON_CAP_KIND,
  schema: DbAbandonCapPayloadSchema,
  fingerprint: abandonCapFingerprint,
  duressExempt: true,
  meta: {
    tag: "[db]",
    notif: "Too many abandoned database connections",
    variant: "error",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) =>
    renderAbandonCapTask(row, DbAbandonCapPayloadSchema.parse(row.data)),
});
