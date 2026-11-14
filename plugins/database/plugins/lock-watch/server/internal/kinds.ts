import { ReportKind, type ReportRow } from "@plugins/reports/server";
import {
  DB_IDLE_TRANSACTION_ENDED_KIND,
  DB_LOCK_HOLDER_KIND,
  DbIdleTransactionEndedPayloadSchema,
  DbLockHolderPayloadSchema,
} from "../../core";
import {
  idleTransactionEndedFingerprint,
  renderIdleTransactionEndedTask,
} from "./idle-ended-render";
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
    category: "slow-op",
  },
  renderTask: (row: ReportRow) =>
    renderLockHolderTask(row, DbLockHolderPayloadSchema.parse(row.data)),
});

/**
 * The `db-idle-transaction-ended` report kind: **Postgres ended a session that
 * sat idle inside a transaction past the cluster's
 * `idle_in_transaction_session_timeout`, rolling it back.** One row per origin;
 * every session ended bumps it. Filed by the session's own client, or by the
 * watch for a session no app client owns (`core/internal/idle-ended.ts`).
 *
 * Variant `error`: the end is the bound acting; the stall that reached it is a
 * defect in the code. `duressExempt`, like `db-lock-holder`: a stalled
 * transaction and a host in trouble are often one event.
 */
export const idleTransactionEndedKind = ReportKind({
  kind: DB_IDLE_TRANSACTION_ENDED_KIND,
  schema: DbIdleTransactionEndedPayloadSchema,
  fingerprint: idleTransactionEndedFingerprint,
  duressExempt: true,
  meta: {
    tag: "[db]",
    notif: "The database ended a transaction left idle too long",
    variant: "error",
    category: "error",
  },
  renderTask: (row: ReportRow) =>
    renderIdleTransactionEndedTask(
      row,
      DbIdleTransactionEndedPayloadSchema.parse(row.data),
    ),
});
