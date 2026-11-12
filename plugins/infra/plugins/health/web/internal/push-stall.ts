/**
 * How long a server's oldest owed change may go undelivered before live
 * updates count as stuck — the Connection row's threshold
 * (`health/connection-row`) and the wedge watchdog's. A healthy push lands in
 * milliseconds (a throttled value waits at most its window); the heartbeat
 * that reports the age arrives every 20 s, so a stall shows within ~50 s.
 */
export const PUSH_STALL_MS = 30_000;
