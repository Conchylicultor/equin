import { AsyncLocalStorage } from "node:async_hooks";
import { getTableName, is, type SQLWrapper } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  getTableConfig,
  PgDeleteBase,
  type PgColumn,
  type PgTable,
  type SelectedFieldsFlat,
} from "drizzle-orm/pg-core";
import type { SelectResultFields } from "drizzle-orm/query-builders/select.types";
import {
  defineServerContribution,
  getBootMode,
  reportServerError,
  type BootMode,
} from "@plugins/framework/plugins/server-core/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  routeChange,
  type ProducerChange,
  type RoutedChange,
} from "./route-change";
import { routeWithSpan } from "./route-span";

// An in-process change producer: the change source of a table the feed installs
// NO trigger on (see research/2026-10-01-global-scoped-change-routing-p5-p8.md
// P5). A table whose writes are all made by this backend, at a rate where a
// per-statement trigger + changelog row + NOTIFY costs more than what the table
// records (a deduped crash counter UPDATEd thousands of times a minute), declares
// a producer instead: its writes route straight into the live-state cascade from
// the process that made them, coalesced at the source.
//
// THE PRODUCER OWNS THE WRITE VERB. There is no `emit` to call after a write —
// `mutate` runs one insert / update / delete builder on the producer's OWN table
// (a builder on another table is a tsc error), appends `RETURNING <pk>` itself
// and emits exactly the PKs the statement returned: an insert or update (an
// upsert included) is a `U`, a delete a `D`. So "a write followed by no emit"
// and "an emit naming the wrong rows" have no spelling. The executor is the POOL
// (`ProducerExecutor`), which a transaction handle does not satisfy: every
// producer write is one autocommit statement, so its emit is after commit by
// construction — a caller's open transaction cannot host one (and later roll
// it back under an emitted change).
//
// VOLATILE. A producer change has no changelog row and no NOTIFY: a coalesced
// change still pending when the process restarts (or is hot-swapped) is lost.
// Clients resubscribe and load in full, so nothing stays wrong past a
// resubscribe; inside one live subscription a lost emit heals the window's
// membership (its next membership refill re-sorts through `windowIdsOf`) but not
// the values of rows already in the client's base. Hence the guards:
//
//  - A6 (live-state-snapshot): no L2-persisted reader of a produced table, so
//    "lost" never becomes "persisted wrong" (boot throws on static evidence;
//    a persist naming one is refused).
//  - A12: `mutate` on a producer that is not MOUNTED (its `declare` among the
//    collected contributions) throws — its table then has a trigger, so its
//    writes would be fed twice, or routed by a process that never booted it.
//  - A13: `mutate` outside the SERVING backend (`bootMode !== "serve"`) throws.
//    An exec child (a supervised job body, a CLI) has its own runtime and no
//    subscribers, so its emit would be silently lost; it files through the
//    outbox, and the backend's own writer emits.
//  - A11 (`change-feed:producer-writes` check): a write to a produced table
//    that does not go through `mutate` (a drizzle insert/update/delete outside
//    a builder callback, a raw SQL write naming the table) fails the check.
//
// COALESCING. A producer may coalesce at the source: a pending `Map<id, U|D>`
// (last op wins), flushed once per fixed window armed on the first buffered
// change and never re-armed — a true rate cap, which the runtime's debounce is
// not (any flush cycle drains it). The flush routes the deletes, then the
// upserts; `changedAt` is the FLUSH instant, not the earliest buffered emit:
// the window is a declared delay, not a slowdown, so change → tab latency
// (live-state's `update` sample) starts when it closes. Counting it would also
// feed back: every produced table is an observability store written exactly
// while something is slow (slow_ops, traces, reports), so a 2 s window read by
// an open pane would trip the 1 s `update` threshold, whose slow-op is a new
// write to the table, whose push trips it again — forever. An `interactive` write flushes the whole buffer as soon
// as its statement resolves (somebody is waiting to see it). Above
// `PRODUCER_IDS_CAP` distinct ids the flush routes `ids: null` instead — one
// bounded FULL per reading tuple.
//
// ROOT CONTEXT. The window's timer and every flush run in the async context
// captured at module eval (`AsyncLocalStorage.snapshot()`), never the writer's:
// a writer inside `runWithoutProfiling` (every observability write is) would
// otherwise hide the `route` span and the whole flush cycle it schedules from
// the profiler.

/**
 * Above this many distinct ids, a flush routes `ids: null` (one bounded FULL per
 * reading tuple) instead of the id list. Its own bound — the size of the id list
 * a flush holds in memory and asks every reader to refill — not the trigger's,
 * which caps a NOTIFY payload in bytes.
 */
export const PRODUCER_IDS_CAP = 1000;

/**
 * The pool, never a transaction (T4): a drizzle transaction handle carries
 * `rollback()`, which this type forbids — so a producer write cannot run inside
 * a caller's transaction and emit a change that transaction later rolls back.
 */
export type ProducerExecutor = NodePgDatabase & { readonly rollback?: never };

/** How a `mutate` caller is waiting on its write. Required — no default (T6). */
export type WriteLatency = "background" | "interactive";

export interface ChangeProducerSpec<T extends PgTable> {
  /** The produced table. Its primary key must be a single column (module-eval throw). */
  table: T;
  /**
   * The only arm: no changelog, no NOTIFY — a pending change is lost on restart
   * (see the volatility contract above). Stated so a reader of the declaration
   * sees the trade without reading this file.
   */
  durability: "volatile";
  /** Why this table is produced rather than triggered — a reviewed decision. */
  reason: string;
  /** A fixed coalescing window at the source, with its reason, or `"none"` (each write routes at once). */
  coalesce: { ms: number; reason: string } | "none";
}

/**
 * A drizzle insert / update / delete builder on `T` — at any step of its chain
 * (`.values()`, `.onConflictDoUpdate()`, `.set()`, `.where()`, each of which
 * narrows the builder's type) — that has not called `.returning()` itself
 * (`mutate` appends the PK). Read off the builders' own type brand: a builder
 * on another table, an unfinished `update(t)` with no `.set()`, a select, or a
 * raw `sql` statement is not one.
 */
export type ProducerBuilder<T extends PgTable> = SQLWrapper & {
  readonly _: { readonly table: T; readonly returning: undefined };
};

export interface ChangeProducerOptions<R extends SelectedFieldsFlat> {
  latency: WriteLatency;
  /** Columns to return from the statement (the PK is added for the emit, then dropped). */
  returning?: R;
}

export interface ChangeProducer<T extends PgTable> {
  readonly table: T;
  readonly tableName: string;
  /**
   * Run one INSERT / UPSERT / UPDATE / DELETE builder on `table` through the
   * pool (one autocommit statement), emit the PKs it returned, and return the
   * rows (the `returning` columns). Throws if the producer is not mounted (A12)
   * or this process is not the serving backend (A13).
   */
  mutate<R extends SelectedFieldsFlat = Record<string, never>>(
    executor: ProducerExecutor,
    build: (q: ProducerExecutor, table: T) => ProducerBuilder<T>,
    opts: ChangeProducerOptions<R>,
  ): Promise<SelectResultFields<R>[]>;
  /** The contribution that mounts this producer — put it in the owner's `contributions`. */
  readonly declare: ChangeProducerContribution;
}

// The mount: a producer is live only once its owner contributed `declare`,
// collected before any `onReadyBlocking` — which is also when the feed reads the
// produced set (denylist, A1′, A2′). It names the table, which names the
// producer: a table has at most one (A2′).
const ChangeProducerDecl = defineServerContribution<{ table: PgTable }>(
  "change-producer",
  { docLabel: (c) => getTableName(c.table) },
);

export type ChangeProducerContribution = ReturnType<typeof ChangeProducerDecl>;

// The return-key the PK rides under — never a column name a caller requests.
const PK_KEY = "__changeProducerPk";

type Op = "U" | "D";

// Captured once, at module eval — outside any request, loader, lane or
// suppression scope — so the coalescing timer and every flush run there.
const inRoot = AsyncLocalStorage.snapshot();

// One producer per table (A2′, module eval): two producers would each believe
// they are the table's only change source.
const byTable = new Map<string, ChangeProducer<PgTable>>();

// The test seam's mounts (`mountProducersForTest`): a producer mounted here is
// live without a booted plugin graph, routes through `route` and runs as if in
// boot mode `mode`.
interface TestMount {
  route: (change: RoutedChange) => void;
  mode: BootMode;
}
const testMounts = new Map<string, TestMount>();

// Each produced table's coalescing buffer.
interface Buffer {
  pending: Map<string, Op>;
  timer: ReturnType<typeof setTimeout> | null;
}
const buffers = new Map<string, Buffer>();

// The table's single-column PK, or a throw naming the table.
function singlePkColumn(table: PgTable): PgColumn {
  const config = getTableConfig(table);
  const primary = config.columns.filter((c) => c.primary);
  const composite = config.primaryKeys.flatMap((pk) => pk.columns);
  const columns = [...primary, ...composite];
  if (columns.length !== 1) {
    throw new Error(
      `[change-feed] defineChangeProducer: table "${config.name}" must have a single-column primary key (it has ${columns.length}) — a producer emits each changed row's PK as its id`,
    );
  }
  return columns[0]!;
}

/**
 * Declare `spec.table`'s in-process change producer (see the contract above).
 * Module eval: throws on a table with no single-column PK, and on a second
 * producer for the same table.
 */
export function defineChangeProducer<T extends PgTable>(
  spec: ChangeProducerSpec<T>,
): ChangeProducer<T> {
  const tableName = getTableName(spec.table);
  const pk = singlePkColumn(spec.table);
  if (byTable.has(tableName)) {
    throw new Error(
      `[change-feed] defineChangeProducer: table "${tableName}" already has a change producer — a table has exactly one change source`,
    );
  }
  if (spec.coalesce !== "none" && !(spec.coalesce.ms > 0)) {
    throw new Error(
      `[change-feed] defineChangeProducer: "${tableName}" coalesce.ms must be > 0 (got ${spec.coalesce.ms}) — pass "none" to route each write at once`,
    );
  }
  async function mutate<R extends SelectedFieldsFlat>(
    executor: ProducerExecutor,
    build: (q: ProducerExecutor, table: T) => ProducerBuilder<T>,
    opts: ChangeProducerOptions<R>,
  ): Promise<SelectResultFields<R>[]> {
    const route = liveRoute(tableName);
    const builder = build(executor, spec.table);
    const op: Op = is(builder, PgDeleteBase) ? "D" : "U";
    // `ProducerBuilder` excludes a builder that already called `.returning()`,
    // so appending it here is the statement's only RETURNING.
    const returned = await (
      builder as unknown as {
        returning(
          fields: SelectedFieldsFlat,
        ): Promise<Record<string, unknown>[]>;
      }
    ).returning({ ...opts.returning, [PK_KEY]: pk });
    const ids: string[] = [];
    const rows: Record<string, unknown>[] = [];
    for (const { [PK_KEY]: id, ...row } of returned) {
      ids.push(String(id));
      rows.push(row);
    }
    emit(tableName, spec.coalesce, op, ids, route);
    if (opts.latency === "interactive") flush(tableName, route);
    // The rows are exactly the requested `returning` columns, decoded by drizzle.
    return rows as SelectResultFields<R>[];
  }
  const producer: ChangeProducer<T> = {
    table: spec.table,
    tableName,
    mutate,
    declare: ChangeProducerDecl({ table: spec.table }),
  };
  byTable.set(tableName, producer as ChangeProducer<PgTable>);
  return producer;
}

// A12 + A13, then where the table's changes route.
function liveRoute(tableName: string): (change: RoutedChange) => void {
  const test = testMounts.get(tableName);
  const mounted =
    test !== undefined ||
    (ChangeProducerDecl.getContributionsIfCollected()?.some(
      (c) => getTableName(c.table) === tableName,
    ) ??
      false);
  if (!mounted) {
    throw new Error(
      `[change-feed] change producer for "${tableName}" is not mounted — add its \`declare\` to the owning plugin's server \`contributions\` (A12)`,
    );
  }
  const mode = test?.mode ?? getBootMode();
  if (mode !== "serve") {
    throw new Error(
      `[change-feed] change producer for "${tableName}" refused a write in boot mode "${mode}": only the serving backend has the subscribers its change must reach (A13) — file the write through the outbox instead`,
    );
  }
  return test?.route ?? routeChange;
}

// Buffer one statement's returned ids; route at once for an uncoalesced
// producer, else arm the window (once) in the root context.
function emit(
  tableName: string,
  coalesce: ChangeProducerSpec<PgTable>["coalesce"],
  op: Op,
  ids: readonly string[],
  route: (change: RoutedChange) => void,
): void {
  if (ids.length === 0) return; // the statement changed no row
  let buffer = buffers.get(tableName);
  if (!buffer) {
    buffer = { pending: new Map(), timer: null };
    buffers.set(tableName, buffer);
  }
  for (const id of ids) {
    // Last op wins: delete-then-reinsert is a `U`, update-then-delete a `D`.
    buffer.pending.delete(id);
    buffer.pending.set(id, op);
  }
  if (coalesce === "none") {
    flush(tableName, route);
    return;
  }
  if (buffer.timer !== null) return; // a fixed window: never re-armed
  const ms = coalesce.ms;
  buffer.timer = inRoot(() =>
    setTimeout(() => {
      flush(tableName, route);
    }, ms),
  );
  // A pending window never holds the process open: losing it is the volatility
  // contract, not a reason to delay an exit.
  buffer.timer.unref();
}

// Route everything buffered: the deletes, then the upserts (over the cap: one
// id-less change). Runs in the root context, under its own `bg` span. The
// buffer is already swapped out, so each change routes on its own: a throw
// routing the deletes must not lose the upserts. A routing throw is filed (with
// the change it lost) and the loop goes on — never an unhandled rejection of
// the fire-and-forget flush.
function flush(tableName: string, route: (change: RoutedChange) => void): void {
  const buffer = buffers.get(tableName);
  if (!buffer) return;
  if (buffer.timer !== null) {
    clearTimeout(buffer.timer);
    buffer.timer = null;
  }
  if (buffer.pending.size === 0) return;
  const pending = buffer.pending;
  const changedAt = Date.now();
  buffer.pending = new Map();
  const changes = changesOf(tableName, pending, changedAt);
  inRoot(() => {
    void runTracked(`change-producer:${tableName}`, () => {
      for (const change of changes) {
        try {
          routeWithSpan(change, route);
        } catch (err) {
          reportRouteFailure(change, err);
        }
      }
    });
  });
}

function reportRouteFailure(change: ProducerChange, err: unknown): void {
  const lost = change.ids === null ? "all ids" : `${change.ids.length} id(s)`;
  reportServerError({
    message: `[change-feed] change producer for "${change.table}" failed to route its ${change.op} change (${lost}) — readers of the table miss it until they resubscribe: ${err instanceof Error ? err.message : String(err)}`,
    stack: err instanceof Error ? (err.stack ?? null) : null,
    errorType: "ChangeProducerRouteError",
  });
}

/** The changes one flush routes: deletes first, then upserts; `ids: null` over the cap. */
export function changesOf(
  table: string,
  pending: ReadonlyMap<string, Op>,
  changedAt: number,
): ProducerChange[] {
  if (pending.size > PRODUCER_IDS_CAP) {
    return [{ source: "producer", table, op: "U", ids: null, changedAt }];
  }
  const deleted: string[] = [];
  const upserted: string[] = [];
  for (const [id, op] of pending) (op === "D" ? deleted : upserted).push(id);
  const out: ProducerChange[] = [];
  if (deleted.length > 0) {
    out.push({ source: "producer", table, op: "D", ids: deleted, changedAt });
  }
  if (upserted.length > 0) {
    out.push({ source: "producer", table, op: "U", ids: upserted, changedAt });
  }
  return out;
}

/**
 * Drop every pending window and buffered change — called once shutdown starts,
 * so no flush routes into a runtime that is tearing down. What it drops is lost,
 * exactly as a restart mid-window loses it (volatile).
 */
export function dropPendingProducerChanges(): void {
  for (const buffer of buffers.values()) {
    if (buffer.timer !== null) clearTimeout(buffer.timer);
  }
  buffers.clear();
}

/**
 * The producer of `table`, if one is defined — for a generic writer (retention)
 * that must route its write through the producer when the table has one.
 */
export function changeProducerFor(
  table: PgTable,
): ChangeProducer<PgTable> | undefined {
  return byTable.get(getTableName(table));
}

/**
 * The MOUNTED producers' tables: the feed installs no trigger on them, and
 * counts them as covered (A1′). Read in a boot hook — contributions must be
 * collected (throws in a process that never booted the plugin graph).
 */
export function producedTableNames(): Set<string> {
  return new Set(
    ChangeProducerDecl.getContributions().map((c) => getTableName(c.table)),
  );
}

// ── Test seam (re-exported by `server/testing`) ──────────────────────────────

/**
 * Mount `producers` without a booted plugin graph: each is live (A12 passes),
 * runs as boot mode `mode` (default `"serve"`; pass `"exec"` to see A13), and
 * routes through `route` (default the real `routeChange`). Returns the unmount,
 * which also drops anything still buffered.
 */
export function mountProducersForTest(
  producers: readonly ChangeProducer<PgTable>[],
  opts: { route?: (change: RoutedChange) => void; mode?: BootMode } = {},
): () => void {
  for (const { tableName } of producers) {
    testMounts.set(tableName, {
      route: opts.route ?? routeChange,
      mode: opts.mode ?? "serve",
    });
  }
  return () => {
    for (const { tableName } of producers) {
      testMounts.delete(tableName);
      const buffer = buffers.get(tableName);
      if (buffer?.timer) clearTimeout(buffer.timer);
      buffers.delete(tableName);
    }
  };
}

/** Flush `producer`'s coalescing buffer now (a test drives the window by hand). */
export function flushNow(producer: ChangeProducer<PgTable>): void {
  flush(producer.tableName, liveRoute(producer.tableName));
}
