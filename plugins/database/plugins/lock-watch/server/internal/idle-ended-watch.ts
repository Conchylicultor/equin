import { isDbApplicationName } from "@plugins/database/plugins/connection/core";
import {
  idleEndedPayloadFromWatch,
  idleSessionsEnded,
  idleSessionsSeen,
  type DbIdleTransactionEndedPayload,
  type IdleSessionSeen,
  type SessionRow,
} from "../../core";
import type { SessionEnds } from "./read-sessions";

// The watch's half of reporting every session the idle-in-transaction timeout
// ends (`core/internal/idle-ended.ts`): what the previous look saw idle in a
// transaction, and the database's FATAL-end count then. In this backend's
// memory, like the latest look (`state.ts`): the job runs here, once a minute.
let previous: { seen: IdleSessionSeen[]; sessionsFatal: number } | null = null;

/** A session the timeout ended, as this look concludes it. */
export interface IdleEndSeen {
  data: DbIdleTransactionEndedPayload;
  /**
   * An app client owns it (`application_name` `equin:<pool>`): that client saw
   * the server's 25P03 itself and reports it with the exact statement, so the
   * watch only logs it.
   */
  clientReports: boolean;
}

/**
 * Compare this look with the previous one: which sessions the timeout ended in
 * between. Then remember this look for the next. The first look of a backend
 * has nothing to compare with and concludes nothing.
 */
export function noticeIdleEnds(
  rows: readonly SessionRow[],
  ends: SessionEnds,
  now: number,
): IdleEndSeen[] {
  const prior = previous;
  previous = {
    seen: idleSessionsSeen(rows, now),
    sessionsFatal: ends.sessionsFatal,
  };
  if (prior === null) return [];
  return idleSessionsEnded({
    previous: prior.seen,
    current: rows,
    now,
    fatalEnds: ends.sessionsFatal - prior.sessionsFatal,
    boundMs: ends.idleTimeoutMs,
  }).map((s) => ({
    data: idleEndedPayloadFromWatch(s, ends.idleTimeoutMs),
    clientReports: isDbApplicationName(s.applicationName),
  }));
}
