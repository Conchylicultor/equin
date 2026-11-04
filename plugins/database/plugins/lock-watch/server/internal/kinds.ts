import { ReportKind, type ReportRow } from "@plugins/reports/server";
import { DB_LOCK_HOLDER_KIND, DbLockHolderPayloadSchema } from "../../core";
import { lockHolderFingerprint, renderLockHolderTask } from "./render";

/**
 * The `db-lock-holder` report kind: **a session held other sessions back, or
 * sat idle inside a transaction, past the lock watch's bound.** One row per
 * origin; every look that still sees it bumps the row.
 *
 * `duressExempt`: a wedged database and a host in duress are often one event,
 * and this report is the one that names the cause.
 */
export const lockHolderKind = ReportKind({
  kind: DB_LOCK_HOLDER_KIND,
  schema: DbLockHolderPayloadSchema,
  fingerprint: lockHolderFingerprint,
  duressExempt: true,
  meta: {
    tag: "[db]",
    notif: "A database session is holding others back",
    variant: "error",
  },
  renderTask: (row: ReportRow) =>
    renderLockHolderTask(row, DbLockHolderPayloadSchema.parse(row.data)),
});
