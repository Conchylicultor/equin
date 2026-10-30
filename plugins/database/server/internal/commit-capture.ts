import {
  mintExternalWriteId,
  type CommitCapture,
} from "@plugins/infra/plugins/endpoints/core";

// The COMMIT CAPTURE the database gives `implement` (`infra/endpoints`'
// `commit-capture.ts`): which transactions a predicted write's handler
// committed, so its response can name them and the browser can confirm the
// prediction causally (the tuple's frames acked one of them, or carry a
// watermark past them — live-state's Rules A / B′).
//
// Every write the handler makes through `db` is attributed, whatever its form:
//
// - a top-level `db.transaction(…)` — the `db` Proxy (`driver.ts`) reads its
//   assigned xid inside it, just before the commit, and notes it once the
//   commit succeeded;
// - an autocommit write (`db.insert(…)`, `db.execute(…)` outside a
//   transaction) — the host's driver runs it in a transaction of its own
//   whose xid it reads the same way (`noteCommit`; the desktop's pool wrapper,
//   `machine/internal/pg-driver.ts`).
//
// Attribution needs an async context that follows the handler through its
// awaits, which only some hosts have: the scope's runtime is INJECTED (the
// desktop's driver installs an AsyncLocalStorage one), and with none installed
// nothing is captured — the response carries no ids, and the client confirms
// at the ack as it did before.

/** The scope of one captured handler: the writes it made, in order. */
interface CommitScope {
  readonly commits: string[];
}

/** The async context the scope rides — installed by a host that has one. */
export interface CommitScopeRuntime {
  run<T>(scope: CommitScope, fn: () => Promise<T>): Promise<T>;
  current(): CommitScope | undefined;
}

let runtime: CommitScopeRuntime | null = null;

/** Install the host's async-context runtime (the desktop driver's, at pool construction). */
export function installCommitScopeRuntime(next: CommitScopeRuntime): void {
  runtime = next;
}

/** Whether a write made now is attributed to a captured handler. */
export function inCommitScope(): boolean {
  return runtime?.current() !== undefined;
}

/**
 * Attribute a COMMITTED transaction to the enclosing captured handler (a
 * no-op outside one, and for `null` — a transaction that wrote nothing, so
 * Postgres assigned it no xid).
 */
export function noteCommit(xid: string | null): void {
  if (xid === null) return;
  if (!/^\d+$/.test(xid)) {
    throw new Error(
      `[database] noteCommit: ${JSON.stringify(xid)} is not a transaction id (xid8 decimal text)`,
    );
  }
  runtime?.current()?.commits.push(xid);
}

/**
 * Attribute a write to a source outside Postgres (an external live value's
 * `notify()` — a config file the handler rewrote) to the enclosing captured
 * handler: its fresh id, named in the response beside the handler's commits
 * and carried by the recompute's frame as `ackTx`, so the browser confirms the
 * prediction on that frame rather than at the ack. `undefined` outside one (a
 * file watcher, a job): nothing waits on that change.
 */
export function noteExternalWrite(): string | undefined {
  const scope = runtime?.current();
  if (scope === undefined) return undefined;
  const id = mintExternalWriteId();
  scope.commits.push(id);
  return id;
}

/**
 * The SQL that reads the current transaction's xid without assigning one —
 * `null` for a transaction that has written nothing yet.
 */
export const ASSIGNED_XID_SQL =
  "SELECT pg_current_xact_id_if_assigned()::text AS xid";

/** The capture `implement` runs a predicted handler under. */
export const dbCommitCapture: CommitCapture = {
  async run(fn) {
    if (runtime === null) return { value: await fn(), commits: [] };
    const scope: CommitScope = { commits: [] };
    const value = await runtime.run(scope, fn);
    return { value, commits: [...scope.commits] };
  },
};
