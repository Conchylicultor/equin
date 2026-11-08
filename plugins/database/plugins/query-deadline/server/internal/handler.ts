import {
  formatDeadlineLogLine,
  type QueryDeadlineEvent,
} from "@plugins/database/plugins/connection/server";
import { crashFieldsOf } from "@plugins/packages/plugins/error-subject/core";
import type { recordReport } from "@plugins/reports/plugins/engine/server";
import type { captureTrace } from "@plugins/debug/plugins/trace/plugins/engine/server";
import {
  DB_QUERY_DEADLINE_KIND,
  type DbQueryDeadlinePayload,
} from "../../core";
import type { HitRing } from "./hit-ring";
import { reportServerError } from "@plugins/framework/plugins/server-core/core";
import { queryDeadlineMessage } from "./render";

export interface QueryDeadlineHandlerDeps {
  /**
   * `recordReport` in the app; a recorder in tests. Named for what it is: the
   * detached-work lint trusts a `void recordReport(…)` because recordReport
   * attributes its own DB write (background lane, no profiling), and it
   * recognises the call by this name.
   */
  recordReport: typeof recordReport;
  /** `captureTrace` in the app: the coherent instant the report links to. */
  captureTrace: typeof captureTrace;
  /** The in-memory ring behind the `db-query-deadlines` resource. */
  ring: HitRing;
  /** Push the ring to every subscribed tab. */
  notify: () => void;
  /** Append one line to the durable `db` log (`db.jsonl`): `dbLog.publish` in the app. */
  log: (line: string) => void;
}

/**
 * The `queryDeadlineSink` handler: one seam event in, one report (and, for a
 * lost query, one ring entry + one push) out.
 *
 * Synchronous, like the seam: it is called from the deadline timer on the
 * rejection path. `recordReport` is a DB write, so it is detached (`void`); a
 * failure inside it surfaces as an unhandled rejection, which the reports
 * plugin itself files. The ring and the push happen FIRST and never wait on it,
 * so the Database health row turns even when the report write is the thing
 * that cannot reach the database.
 *
 * Source `server-caught`: the deadline is an error the server caught in-process
 * and turned into a rejection — no monitor polled for it.
 */
export function createQueryDeadlineHandler(
  deps: QueryDeadlineHandlerDeps,
): (event: QueryDeadlineEvent) => void {
  // The latest trace per trigger label. A miss inside the trace cooldown gets
  // no trace of its own, and the report upsert replaces `data` on every
  // occurrence — so without this, the second miss of a burst would erase the
  // link the first one wrote. Reused only for a miss within one deadline of
  // it — a call whose wait overlapped the traced instant — never for a later,
  // unrelated one (captureTrace also answers null when tracing is off). One
  // entry per (pool, phase): bounded by the closed name sets.
  const lastTrace = new Map<string, { id: string; at: number }>();
  return (event) => {
    // The durable line first: it needs no database, so it lands even when the
    // report write below is the call that cannot reach one.
    deps.log(formatDeadlineLogLine(event));
    deps.ring.push({
      at: event.at,
      pool: event.pool,
      phase: event.phase,
      sql: event.sql,
      origin: event.origin,
      elapsedMs: event.elapsedMs,
    });
    deps.notify();

    const call = {
      sql: event.sql,
      elapsedMs: event.elapsedMs,
      deadlineMs: event.deadlineMs,
      origin: event.origin,
      pool: event.pool,
      phase: event.phase,
      reason: event.reason,
      transaction: event.transaction,
      inFlight: event.inFlight,
      inFlightCount: event.inFlightCount,
    };
    // The evidence: everything in flight at this instant (spans, gates, host
    // and Postgres contention), linked from the report. Critical, like a stuck
    // span's: a lost call is the severe signal, so neither the per-minute cap
    // nor duress shedding may drop it.
    //
    // The label is the connection (pool + phase), NOT the report's origin key:
    // the per-label cooldown then bounds traces to one per pool per cooldown
    // however many callers lose calls together — a wedged database loses calls
    // from every origin at once, and they all share one picture. It also bounds
    // the loop a trace could feed: persisting it is itself a database write,
    // which on a wedged database is lost in turn and reported here, with no
    // origin, under a label of its own were the label per caller.
    //
    // The trace is evidence, the report is the alert: a throw out of the
    // capture (a trace class, its config read) is reported on its own and the
    // report still files, without the link.
    const label = `${event.pool}:${event.phase}`;
    try {
      const trace = deps.captureTrace({
        kind: DB_QUERY_DEADLINE_KIND,
        label,
        durationMs: event.elapsedMs,
        thresholdMs: event.deadlineMs,
        critical: true,
        detail: call,
      });
      if (trace) lastTrace.set(label, { id: trace.id, at: event.at });
    } catch (err) {
      reportServerError({
        message: `[db] query-deadline: capturing the trace of a lost call failed: ${err instanceof Error ? err.message : String(err)}`,
        ...crashFieldsOf(err),
        errorType: "QueryDeadlineTraceError",
      });
    }
    const latest = lastTrace.get(label);
    const data: DbQueryDeadlinePayload = {
      ...call,
      traceId:
        latest && event.at - latest.at <= event.deadlineMs ? latest.id : null,
    };
    void deps.recordReport({
      kind: DB_QUERY_DEADLINE_KIND,
      source: "server-caught",
      message: queryDeadlineMessage(data),
      data,
    });
  };
}
