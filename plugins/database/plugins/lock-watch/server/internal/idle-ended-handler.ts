import {
  formatIdleTransactionEndedLogLine,
  type IdleTransactionEndedEvent,
} from "@plugins/database/plugins/connection/server";
import type { recordReport } from "@plugins/reports/plugins/engine/server";
import {
  DB_IDLE_TRANSACTION_ENDED_KIND,
  cutLockWatchSql,
  type DbIdleTransactionEndedPayload,
} from "../../core";
import { idleTransactionEndedMessage } from "./idle-ended-render";

export interface IdleTransactionEndedHandlerDeps {
  /** `recordReport` in the app; a recorder in tests (named so for the detached-work lint). */
  recordReport: typeof recordReport;
  /** Append one line to `db.jsonl`: `dbLog.publish` in the app. */
  log: (line: string) => void;
}

/** The report payload for a session its own client saw ended. */
export function idleEndedPayloadFromClient(
  event: IdleTransactionEndedEvent,
): DbIdleTransactionEndedPayload {
  return {
    observedBy: "client",
    origin: event.origin,
    sql: event.sql !== null ? cutLockWatchSql(event.sql) : null,
    openedBy: event.openedBy,
    pool: event.pool,
    applicationName: null,
    pid: null,
    transactionMs: event.transactionMs,
    idleMs: event.idleMs,
    boundMs: null,
  };
}

/**
 * The `idleTransactionEndedSink` handler: one session the server ended for
 * idling in its transaction in, one `db.jsonl` line and one report out.
 * Synchronous, like the seam (it runs inside the connection's `error` emit);
 * the report is a DB write, so it is detached — through `db`, never the
 * connection that just ended.
 *
 * Source `server-caught`: the client caught the server's 25P03.
 */
export function createIdleTransactionEndedHandler(
  deps: IdleTransactionEndedHandlerDeps,
): (event: IdleTransactionEndedEvent) => void {
  return (event) => {
    deps.log(formatIdleTransactionEndedLogLine(event));
    const data = idleEndedPayloadFromClient(event);
    void deps.recordReport({
      kind: DB_IDLE_TRANSACTION_ENDED_KIND,
      source: "server-caught",
      message: idleTransactionEndedMessage(data),
      data,
    });
  };
}
