/**
 * The exit status of a `run`-body child that failed for a reason expected to
 * clear on its own — today exactly one: the database refused its connection
 * because the server side was full (`isConnectionCapacityRefusal`:
 * pgbouncer's `max_client_conn`, Postgres's 53300). The child could not even
 * record that on its run's row — the row is in the database that refused it —
 * so the status itself carries the classification to whoever waits on the run.
 *
 * 75 is EX_TEMPFAIL from sysexits.h: "temporary failure, the user is invited to
 * retry". A waiter reads it as back-pressure: retry later, and do not count it
 * as the work failing (`worktree.prepare`'s waiter, `prepareWorktree`). Every
 * other failure still exits 1.
 */
export const SUPERVISED_EXIT_TEMPFAIL = 75;
