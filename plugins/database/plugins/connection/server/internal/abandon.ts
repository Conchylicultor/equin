import type { ClientBase, Pool } from "pg";
import { isInTransaction, type DbPoolName } from "../../core";
import { queryDeadlineSink, txStateOf } from "./deadline";

// ---------------------------------------------------------------------------
// Abandoning a connection.
//
// A missed deadline means the connection's socket may be dead in a way `pg`
// cannot see — in the incident, its fd had been closed by someone else. By the
// time the deadline fires that fd NUMBER is free and probably reused by some
// other resource (a pipe, a temp file, another pg socket). Closing the client
// (`client.end()` → `stream.destroy()`, which pg-pool's `_remove` and
// `release(err)` always do, and which pg's and pg-pool's own
// `connectionTimeoutMillis` do too) would close THAT resource: a new victim per
// incident, possibly another pooled socket, so a cascade every deadline.
//
// So the client is ABANDONED: detached from its pool, never closed. The cost for
// a call that was merely slow is one leaked server connection; a late reply can
// only resolve an already-settled call, a no-op, because nothing hands the
// client out again.
// ---------------------------------------------------------------------------

/** How many abandoned clients are kept strongly reachable. */
export const ABANDON_HOLD_CAP = 32;

/**
 * The strong-reference hold for abandoned clients, so GC finalization can never
 * close their fd later. Bounded: past `cap` a newly abandoned client is still
 * detached from its pool but not retained, and each such abandon is emitted as
 * `abandon-cap` — by then something is badly wrong and a human must look.
 */
export class AbandonedClientHold {
  private readonly held = new Set<ClientBase>();
  private readonly seen = new WeakSet<ClientBase>();
  private count = 0;

  constructor(readonly cap: number) {}

  /** Every abandon since this hold was created. */
  get abandoned(): number {
    return this.count;
  }

  /** How many abandoned clients are strongly held right now (≤ cap). */
  get size(): number {
    return this.held.size;
  }

  /**
   * How many held clients were left inside a transaction (open or failed) as of
   * their last reply. Each is a server session that may still hold row locks.
   */
  get inTransaction(): number {
    let n = 0;
    for (const client of this.held) {
      if (isInTransaction(txStateOf(client))) n++;
    }
    return n;
  }

  has(client: ClientBase): boolean {
    return this.seen.has(client);
  }

  /** Record one abandon; emits `abandon-cap` when the hold is already full. */
  retain(client: ClientBase, pool: DbPoolName): void {
    this.seen.add(client);
    this.count++;
    if (this.held.size < this.cap) {
      this.held.add(client);
      return;
    }
    queryDeadlineSink.emit({
      kind: "abandon-cap",
      at: Date.now(),
      pool,
      abandoned: this.count,
      cap: this.cap,
    });
  }
}

/** The process-wide hold every connection built by this plugin abandons into. */
export const abandonedClients = new AbandonedClientHold(ABANDON_HOLD_CAP);

// pg-pool 3.13 has no public detach-without-end, so abandoning reaches into
// its internals: `_clients`, `_idle` (and each idle item's `idleListener` /
// `timeoutId`) and `_pulseQueue`. They are read through this one accessor (and
// pinned by deadline.test.ts), so an upgrade that renames them fails loudly — at
// pool build (`assertPgPoolInternals`) and in the test — rather than silently
// leaving an abandoned client counted in the pool.
interface PgPoolInternals {
  /** Every client the pool owns, checked out or idle; `totalCount` is its length. */
  _clients: ClientBase[];
  /**
   * Idle clients, each with its idle-timeout timer and the pool's `error`
   * listener (attached only while idle; its firing `end()`s the client).
   */
  _idle: {
    client: ClientBase;
    idleListener: (err: Error) => void;
    timeoutId: ReturnType<typeof setTimeout> | undefined;
  }[];
  /** Hands the next queued checkout a client, building one if under `max`. */
  _pulseQueue(): void;
}

function readPgPoolInternals(pool: Pool): PgPoolInternals {
  const p = pool as unknown as Partial<PgPoolInternals>;
  if (
    !Array.isArray(p._clients) ||
    !Array.isArray(p._idle) ||
    typeof p._pulseQueue !== "function"
  ) {
    throw new Error(
      "pg-pool internals changed: abandonClient needs Pool#_clients, Pool#_idle and " +
        "Pool#_pulseQueue (pg-pool 3.13). Re-check abandonClient in " +
        "plugins/database/plugins/connection/server/internal/abandon.ts against the new pg-pool.",
    );
  }
  return p as PgPoolInternals;
}

/** Throws unless `pool` exposes the pg-pool internals `abandonClient` relies on. */
export function assertPgPoolInternals(pool: Pool): void {
  readPgPoolInternals(pool);
}

// Named so a heap snapshot says why the listener is there.
function ignoreAbandonedClientEvent(): void {}

/**
 * Take `client` out of use for good WITHOUT closing it. Idempotent.
 *
 * 1. Attach permanent no-op `error` and `end` listeners first. A checked-out
 *    client has no pool listener, and a detached one never gets one back — a
 *    later socket error with no listener is an unhandled `'error'` that crashes
 *    the process.
 * 2. With a `pool`: remove it from pg-pool's `_clients` and `_idle` (clearing its
 *    idle timer and the pool's idle `error` listener, either of which would
 *    `end()` it), so `totalCount` drops; then pulse the queue so a waiting
 *    checkout gets a replacement now rather than on the next release. Never
 *    `client.end()` / `release(err)`: both close the fd. `null` for a
 *    standalone client.
 * 3. Hold a strong reference (`AbandonedClientHold`).
 */
export function abandonClient(
  pool: Pool | null,
  client: ClientBase,
  poolName: DbPoolName,
  hold: AbandonedClientHold = abandonedClients,
): void {
  if (hold.has(client)) return;
  client.on("error", ignoreAbandonedClientEvent);
  client.on("end", ignoreAbandonedClientEvent);

  if (!pool) {
    hold.retain(client, poolName);
    return;
  }

  const internals = readPgPoolInternals(pool);
  const idleIndex = internals._idle.findIndex((item) => item.client === client);
  if (idleIndex !== -1) {
    // Only reachable for an idle client (a deadline always abandons a
    // checked-out or still-connecting one, which pg-pool keeps out of `_idle`).
    const [item] = internals._idle.splice(idleIndex, 1);
    clearTimeout(item!.timeoutId);
    client.removeListener("error", item!.idleListener);
  }
  const clientIndex = internals._clients.indexOf(client);
  if (clientIndex !== -1) internals._clients.splice(clientIndex, 1);

  hold.retain(client, poolName);
  internals._pulseQueue();
}
