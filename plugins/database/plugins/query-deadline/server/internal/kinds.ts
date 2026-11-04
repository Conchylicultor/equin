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

// `duressExempt: true` on both kinds. A lost query and a host in trouble are
// often the same event: the box is struggling, the sentinel latches duress, and
// the reports funnel starts shedding. Without the flag `recordReport` would
// buffer exactly the reports that describe the outage — the alarm silenced by
// the outage (Silencer 2 of the 2026-08-17 incident; the same argument
// `jobs/deadline-audit` and `queue-health`'s wedged kind make). Volume is
// bounded without the gate: a lost query costs a full deadline each, and the
// fingerprint dedupes repeats onto one row.

/**
 * The `db-query-deadline` report kind: **one query got no answer before its
 * deadline, failed its caller, and had its connection closed.**
 *
 * Variant `error`: unlike a job deadline (the system working as designed), a
 * call the database never answers is a defect — a lock chain, a wedged server,
 * or a socket closed underneath it. The task says how to tell them apart.
 */
export const queryDeadlineKind = ReportKind({
  kind: DB_QUERY_DEADLINE_KIND,
  schema: DbQueryDeadlinePayloadSchema,
  fingerprint: queryDeadlineFingerprint,
  duressExempt: true,
  meta: {
    tag: "[db]",
    notif: "A database call got no answer and its connection was closed",
    variant: "error",
    notifCooldownMs: NOTIF_COOLDOWN_MS,
  },
  renderTask: (row: ReportRow) =>
    renderQueryDeadlineTask(row, DbQueryDeadlinePayloadSchema.parse(row.data)),
});

/**
 * The RETIRED `db-abandon-cap` report kind: the process had abandoned more lost
 * connections than its hold set was sized for. Nothing files it since lost
 * connections are closed (2026-11-04); kept registered so existing rows still
 * validate, render and can be investigated (an investigated report is never
 * swept).
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
