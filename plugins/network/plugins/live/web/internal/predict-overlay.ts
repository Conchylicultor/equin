// The PREDICT OVERLAY: the predicted writes in flight (an endpoint's declared
// `effect`, sent by `useLiveMutation`), applied on top of every live read of
// the rows they target — design in
// research/2026-10-27-global-predicted-endpoint-effects.md §2.
//
// There is no normalized row store: each live tuple (`useLiveRow`'s `:rows`
// tuple, a window's pages, an `all` set) holds its own rows, and a row leaving
// one tuple and entering another arrives as two uncorrelated frames. So the
// overlay is keyed by ENTITY ROW `(entity name, id)` — what an effect targets
// — and every read of a collection `from` that entity folds the ops over its
// own server rows. A collection that declares its `membership` drops a row the
// prediction moved out of it; entering a tuple is never predicted (its row key
// and counts are the server's).
//
// RETIREMENT IS PER TUPLE. Each mounted read registers as a HOLDER of its
// tuple's server rows. For a holder and an op:
//
// - `confirmed` — the tuple's server data already shows the write: a `row`
//   target's row is present and `confirmedBy` it (the `set` fields agree), or
//   a removal's row is absent; a `rows` target (`applyRows`, no compared
//   fields) once the write is acked. The op stops applying to THAT tuple for
//   good (`retired`), whatever the others show.
// - `needs` — the tuple still holds the target row and its server data does
//   not show the write yet: the op keeps applying there.
// - `irrelevant` — the tuple does not hold the row (it never did, or the
//   server already moved it out): nothing to apply.
//
// An op is DONE — removed, its confirm sample emitted — once it is ACKED and
// no registered holder of its entities `needs` it. That is the race this
// prevents: the by-id tuple confirms first (retired there), while the active
// list's tuple still holds the stale row — the op keeps hiding it there until
// the list's own frame drops it. Every evaluation is push-driven: a holder's
// data-change edge, an ack, a holder leaving (`sweep`), never a timer.

import type {
  LiveMembership,
  ResolvedLiveTarget,
} from "@plugins/network/plugins/live/core";
import { matchesFilter } from "@plugins/network/plugins/live/plugins/filter/core";

/** A row as the overlay handles it — any collection's, untyped. */
export type PredictRow = Readonly<Record<string, unknown>>;

/**
 * Why a predicted write's latest send failed while it stays applied
 * (never-revert): `network` — no HTTP verdict (offline, server restarting),
 * retried on the next reconnect edge; `http` — a TRANSIENT status
 * (`classifyRejection`), retried by the user (the sync cloud's Retry). A
 * permanent rejection is never a failure: the op leaves the overlay.
 */
export type PredictFailure =
  | { readonly kind: "network" }
  | { readonly kind: "http"; readonly status: number };

/** One predicted write in flight. Immutable: the store replaces it on every change. */
export interface PredictOp {
  readonly opId: string;
  /** The endpoint's route — the confirm sample's key and variant. */
  readonly route: string;
  /** The request's params (route params are strings) — the sample's params. */
  readonly params: Readonly<Record<string, string>>;
  readonly targets: readonly ResolvedLiveTarget[];
  /** The entities its targets name — what a holder is matched on. */
  readonly entities: ReadonlySet<string>;
  /** `performance.now()` stamps of the lifecycle — the confirm sample's phases. */
  readonly dispatchedAt: number;
  readonly firstSentAt?: number;
  readonly lastSentAt?: number;
  readonly ackedAt?: number;
  /** Present while its latest send failed (see {@link PredictFailure}). */
  readonly failure?: PredictFailure;
  /** The holder tuples that confirmed it — where it no longer applies. */
  readonly retired: ReadonlySet<string>;
}

/**
 * One mounted read of a tuple of an entity's rows — what retirement is
 * decided against. `rows()` is the tuple's SERVER rows as last rendered
 * (never the overlaid ones), `undefined` while it holds none.
 */
export interface PredictHolder {
  /** The tuple's identity: two reads of one tuple share it (and its retirement). */
  readonly tupleKey: string;
  readonly entity: string;
  readonly idField: string;
  rows(): readonly PredictRow[] | undefined;
}

/** What one holder's server data says of one op. */
export type HolderVerdict = "confirmed" | "needs" | "irrelevant";

const EMPTY_OPS: readonly PredictOp[] = Object.freeze([]);

/** The ops that still apply to `tupleKey` and touch `entity`, in dispatch order. */
export function applicableOps(
  ops: readonly PredictOp[],
  tupleKey: string,
  entity: string,
): readonly PredictOp[] {
  if (ops.length === 0) return EMPTY_OPS;
  const out = ops.filter(
    (op) => op.entities.has(entity) && !op.retired.has(tupleKey),
  );
  return out.length === 0 ? EMPTY_OPS : out;
}

/**
 * The predicted row, keeping only the keys the server row has: a patch may
 * name a field another collection of the entity carries, and a read hands
 * out exactly its own row shape.
 */
function keepShape(server: PredictRow, predicted: PredictRow): PredictRow {
  let out: Record<string, unknown> | null = null;
  for (const k of Object.keys(predicted)) {
    if (!(k in server)) {
      out ??= { ...predicted };
      delete out[k];
    }
  }
  return out ?? predicted;
}

/**
 * A tuple's server rows with every op applying to it folded in, in dispatch
 * order: a `row` target patches (or removes) its row when the tuple holds it,
 * a `rows` target reduces the held rows it names (never inserting one); then,
 * when the collection declares its `membership`, every row a prediction
 * changed that no longer matches it is dropped.
 *
 * Returns `rows` itself when nothing changes — so a read no op touches keeps
 * its data's identity (consumers memoize on it).
 */
export function predictRows(
  ops: readonly PredictOp[],
  tupleKey: string,
  entity: string,
  idField: string,
  rows: readonly PredictRow[],
  membership: LiveMembership | undefined,
): readonly PredictRow[] {
  const apply = applicableOps(ops, tupleKey, entity);
  if (apply.length === 0 || rows.length === 0) return rows;
  let work: (PredictRow | undefined)[] | null = null;
  const indexOf = new Map<string, number>();
  rows.forEach((r, i) => indexOf.set(String(r[idField]), i));
  const current = (i: number): PredictRow | undefined =>
    work === null ? rows[i] : work[i];
  const write = (i: number, row: PredictRow | undefined): void => {
    work ??= [...rows];
    work[i] = row;
  };
  for (const op of apply) {
    for (const t of op.targets) {
      if (t.entity !== entity) continue;
      if (t.kind === "row") {
        const i = indexOf.get(t.id);
        if (i === undefined) continue;
        const row = current(i);
        if (row === undefined) continue;
        const next = t.apply(row);
        write(i, next === undefined ? undefined : keepShape(rows[i]!, next));
        continue;
      }
      const held: { i: number; row: PredictRow }[] = [];
      for (const id of t.ids) {
        const i = indexOf.get(id);
        const row = i === undefined ? undefined : current(i);
        if (i !== undefined && row !== undefined) held.push({ i, row });
      }
      if (held.length === 0) continue;
      const out = new Map(
        t.apply(held.map((h) => h.row)).map((r) => [String(r[idField]), r]),
      );
      for (const { i, row } of held) {
        const next = out.get(String(row[idField]));
        write(i, next === undefined ? undefined : keepShape(rows[i]!, next));
      }
    }
  }
  if (work === null) return rows;
  const changed: (PredictRow | undefined)[] = work;
  const kept = changed.filter(
    (row, i): row is PredictRow =>
      row !== undefined &&
      (row === rows[i] ||
        membership === undefined ||
        matchesFilter(row, membership.filter, membership.filterable)),
  );
  return kept;
}

/**
 * One row of a tuple with the ops folded in (`predictRows` over the one row):
 * `undefined` when a prediction removed it or moved it out of the
 * collection's `membership`.
 */
export function predictRow(
  ops: readonly PredictOp[],
  tupleKey: string,
  entity: string,
  idField: string,
  row: PredictRow,
  membership: LiveMembership | undefined,
): PredictRow | undefined {
  const out = predictRows(ops, tupleKey, entity, idField, [row], membership);
  return out[0];
}

/** Whether an op still applying to `tupleKey` targets row `id` — `useLiveRow`'s `pending`. */
export function rowPending(
  ops: readonly PredictOp[],
  tupleKey: string,
  entity: string,
  id: string,
): boolean {
  return applicableOps(ops, tupleKey, entity).some((op) =>
    op.targets.some(
      (t) =>
        t.entity === entity &&
        (t.kind === "row" ? t.id === id : t.ids.includes(id)),
    ),
  );
}

/**
 * What a holder's server rows say of `op` (see the header): any target the
 * tuple still needs wins, then any it confirms; a tuple holding none of the
 * op's rows is irrelevant to it.
 */
export function holderVerdict(
  op: PredictOp,
  holder: PredictHolder,
): HolderVerdict {
  const rows = holder.rows();
  if (rows === undefined) return "irrelevant";
  let confirmed = false;
  for (const t of op.targets) {
    if (t.entity !== holder.entity) continue;
    if (t.kind === "row") {
      const server = rows.find((r) => String(r[holder.idField]) === t.id);
      if (server === undefined) {
        // A removal the tuple already shows; any other target has nothing
        // here to apply to (never an entrant).
        if (t.set === null) confirmed = true;
        continue;
      }
      // A field this collection does not carry cannot disagree: it is read
      // as the predicted value, so only the carried ones are compared.
      if (t.confirmedBy(fillMissing(server, t.set))) confirmed = true;
      else return "needs";
      continue;
    }
    const holds = t.ids.some((id) =>
      rows.some((r) => String(r[holder.idField]) === id),
    );
    if (!holds) continue;
    // No compared fields: only the ack confirms it.
    if (op.ackedAt === undefined) return "needs";
    confirmed = true;
  }
  return confirmed ? "confirmed" : "irrelevant";
}

function fillMissing(
  server: PredictRow,
  set: Readonly<Record<string, unknown>> | null,
): PredictRow {
  if (set === null) return server;
  let out: Record<string, unknown> | null = null;
  for (const [k, v] of Object.entries(set)) {
    if (!(k in server)) {
      out ??= { ...server };
      out[k] = v;
    }
  }
  return out ?? server;
}

/** How an op left the overlay as DONE: when, for its confirm sample. */
export type PredictDone = (op: PredictOp, doneAt: number) => void;

/**
 * The overlay's store — one per transport (`usePredictStore`), so a demo
 * scope's predictions never reach the page's reads. Subscribed with
 * `useSyncExternalStore`; every change replaces the op list.
 */
export interface PredictStore {
  subscribe(listener: () => void): () => void;
  /** Every op in flight, in dispatch order (a new array on every change). */
  ops(): readonly PredictOp[];
  /** The ops touching `entity` — one stable array while they do not change. */
  opsFor(entity: string): readonly PredictOp[];
  op(opId: string): PredictOp | undefined;
  /** Add a dispatched op; `onDone` runs once, when it is DONE (never on removal). */
  add(op: PredictOp, onDone: PredictDone): void;
  /** Replace an op (a stamp, a failure); a no-op once it left. */
  update(opId: string, change: (op: PredictOp) => PredictOp): void;
  /** Drop an op without completing it (a permanent rejection). */
  remove(opId: string): void;
  /** Register a mounted read's tuple; returns its unregistration (which sweeps). */
  register(holder: PredictHolder): () => void;
  /** Re-decide every op against every holder: retire per tuple, complete the done. */
  sweep(): void;
}

export function createPredictStore(
  now: () => number = () => performance.now(),
): PredictStore {
  let ops: readonly PredictOp[] = EMPTY_OPS;
  const done = new Map<string, PredictDone>();
  const holders = new Map<string, Set<PredictHolder>>();
  const listeners = new Set<() => void>();
  const byEntity = new Map<
    string,
    { from: readonly PredictOp[]; ops: readonly PredictOp[] }
  >();

  const commit = (next: readonly PredictOp[]): void => {
    ops = next.length === 0 ? EMPTY_OPS : next;
    for (const l of [...listeners]) l();
  };

  const sweep = (): void => {
    if (ops.length === 0) return;
    let changed = false;
    const finished: PredictOp[] = [];
    const next: PredictOp[] = [];
    for (const op of ops) {
      let retired = op.retired;
      let needed = false;
      for (const entity of op.entities) {
        for (const holder of holders.get(entity) ?? []) {
          if (retired.has(holder.tupleKey)) continue;
          const verdict = holderVerdict(op, holder);
          if (verdict === "confirmed") {
            retired = new Set(retired).add(holder.tupleKey);
          } else if (verdict === "needs") {
            needed = true;
          }
        }
      }
      if (op.ackedAt !== undefined && !needed) {
        finished.push(op);
        changed = true;
        continue;
      }
      if (retired !== op.retired) {
        changed = true;
        next.push({ ...op, retired });
      } else {
        next.push(op);
      }
    }
    if (!changed) return;
    commit(next);
    const at = now();
    for (const op of finished) {
      const cb = done.get(op.opId);
      done.delete(op.opId);
      cb?.(op, at);
    }
  };

  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    ops: () => ops,
    opsFor(entity) {
      const cached = byEntity.get(entity);
      if (cached !== undefined && cached.from === ops) return cached.ops;
      const fresh = ops.filter((op) => op.entities.has(entity));
      // Keep the previous array while its ops are the same objects, so a
      // read of an entity no change touched keeps its snapshot.
      const prev = cached?.ops;
      const same =
        prev !== undefined &&
        prev.length === fresh.length &&
        prev.every((op, i) => op === fresh[i]);
      const result = same ? prev : fresh.length === 0 ? EMPTY_OPS : fresh;
      byEntity.set(entity, { from: ops, ops: result });
      return result;
    },
    op: (opId) => ops.find((o) => o.opId === opId),
    add(op, onDone) {
      if (ops.some((o) => o.opId === op.opId)) {
        throw new Error(`predict overlay: op ${op.opId} added twice`);
      }
      done.set(op.opId, onDone);
      commit([...ops, op]);
    },
    update(opId, change) {
      const i = ops.findIndex((o) => o.opId === opId);
      if (i === -1) return;
      const next = [...ops];
      next[i] = change(ops[i]!);
      commit(next);
    },
    remove(opId) {
      done.delete(opId);
      if (!ops.some((o) => o.opId === opId)) return;
      commit(ops.filter((o) => o.opId !== opId));
    },
    register(holder) {
      let set = holders.get(holder.entity);
      if (set === undefined) {
        set = new Set();
        holders.set(holder.entity, set);
      }
      set.add(holder);
      return () => {
        const s = holders.get(holder.entity);
        s?.delete(holder);
        if (s?.size === 0) holders.delete(holder.entity);
        // A holder leaving may be the last one an acked op waited on.
        sweep();
      };
    },
    sweep,
  };
}
