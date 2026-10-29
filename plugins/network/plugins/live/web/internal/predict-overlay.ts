// The PREDICT OVERLAY: the predicted writes in flight (an endpoint's declared
// `effect`, sent by `useLiveMutation`), applied on top of every live read of
// the rows and values they target — design in
// research/2026-10-27-global-predicted-endpoint-effects.md §2, its gaps closed
// in research/2026-10-28-global-endpoint-prediction-decision.md §3.
//
// There is no normalized row store: each live tuple (`useLiveRow`'s `:rows`
// tuple, a window's pages, an `all` set) holds its own rows, and a row leaving
// one tuple and entering another arrives as two uncorrelated frames. So the
// overlay is keyed by SUBJECT (`predictSubject`: an entity's name, a `from:
// null` collection's key, a value's key) and row id — what an effect targets —
// and every read of that subject folds the ops over its own server rows. A
// collection that declares its `membership` drops a row the prediction moved
// out of it. An upsert ENTERS only a read that admits its row (a by-id read of
// its id, an `all` set it belongs to — its scope, and its `membership` when the
// collection declares one); a window never gains
// an entrant (its row key and counts are the server's). A read ordered by a
// field a prediction rewrote moves the row among the rows it holds; one moved
// past them leaves until the server's frame brings it where it lands.
//
// RETIREMENT IS PER TUPLE. Each mounted read registers as a HOLDER of its
// tuple's server data. For a holder and an op:
//
// - `confirmed` — the tuple's server data already shows the write: a target
//   with compared fields finds its row holding them, a removal its row absent;
//   a target with nothing to compare (a reducer, an upsert with no `set`, a
//   filter-targeted patch, a value) once the write is acked AND the tuple's
//   own frames have seen its commit (`seen`: an `ackTx` naming one of the
//   ack's transactions, or a full frame's watermark past them all). The op
//   stops applying to THAT tuple for good (`retired`), whatever the others
//   show. An ack that names no commit (a host that cannot attribute one)
//   confirms at the ack, as before commit acks existed.
// - `needs` — the tuple still holds a target and its server data does not
//   show the write yet: the op keeps applying there.
// - `irrelevant` — the tuple holds none of the op's targets: nothing to apply.
//
// An op is DONE — removed, its confirm sample emitted — once it is ACKED and
// no registered holder of its subjects `needs` it. That is the race this
// prevents: the by-id tuple confirms first (retired there), while the active
// list's tuple still holds the stale row — the op keeps hiding it there until
// the list's own frame drops it; and an increment's +1 holds until the frame
// that carries it, however late it lands after the ack. Every evaluation is
// push-driven: a holder's data-change edge, an ack, a tuple's ack frame, a
// holder leaving (`sweep`), never a timer.

import type {
  LiveMembership,
  ResolvedLiveTarget,
} from "@plugins/network/plugins/live/core";
import {
  compareScalars,
  filterColumns,
  matchesFilter,
  type FilterScalar,
} from "@plugins/network/plugins/live/plugins/filter/core";

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
  /** The subjects its targets name — what a holder is matched on. */
  readonly subjects: ReadonlySet<string>;
  /** `performance.now()` stamps of the lifecycle — the confirm sample's phases. */
  readonly dispatchedAt: number;
  readonly firstSentAt?: number;
  readonly lastSentAt?: number;
  readonly ackedAt?: number;
  /**
   * The transactions the server's ack named (`COMMITS_HEADER`), set with
   * `ackedAt` — what a target with nothing to compare is confirmed against.
   */
  readonly commits?: readonly string[];
  /** Present while its latest send failed (see {@link PredictFailure}). */
  readonly failure?: PredictFailure;
  /** The holder tuples that confirmed it — where it no longer applies. */
  readonly retired: ReadonlySet<string>;
}

/** A read's order, as row fields — what a prediction that rewrites one re-sorts by. */
export type PredictOrder = readonly (readonly [
  field: string,
  dir: "asc" | "desc",
])[];

/**
 * What a mounted read of rows IS to the overlay: its tuple, the subject it
 * reads, and how a prediction changes its row set.
 */
export interface PredictTuple {
  /** The tuple's identity: two reads of one tuple share it (and its retirement). */
  readonly tupleKey: string;
  readonly subject: string;
  readonly idField: string;
  /** Its collection's declared `membership` — a changed row leaving it is dropped. */
  readonly membership?: LiveMembership;
  /**
   * An upserted row this read ADMITS, shaped as its rows are — or
   * `undefined` when it does not (its id is not in the read's set, it fails
   * the membership, or it lacks a field the read's rows carry). Absent: the
   * read admits no entrant (a window).
   */
  readonly entrant?: (row: PredictRow) => PredictRow | undefined;
  /** The read's order, when every field of it is a row field (re-sorted on a change). */
  readonly order?: PredictOrder;
  /**
   * Rows past the held ones exist (a window not exhausted): a row re-sorted
   * past the last held row leaves the read.
   */
  readonly more?: boolean;
}

/**
 * Whether a tuple's frames have seen every write of a commit ack — any of its
 * transactions acked on the tuple, or a full frame's watermark past them all
 * (`use-predicted.ts` reads the pipeline's registries).
 */
export type CommitSeen = (commits: readonly string[]) => boolean;

/**
 * One mounted read — what retirement is decided against: a tuple of rows
 * (`rows()` is its SERVER rows as last rendered, never the overlaid ones,
 * `undefined` while it holds none), or a tuple of a value.
 */
export type PredictHolder =
  | (PredictTuple & {
      readonly kind: "rows";
      rows(): readonly PredictRow[] | undefined;
      readonly seen: CommitSeen;
    })
  | {
      readonly kind: "value";
      readonly tupleKey: string;
      /** `valueSubject(key)`. */
      readonly subject: string;
      readonly key: string;
      /** {@link valueParamsKey} of the tuple's canonical params. */
      readonly paramsKey: string;
      /** Whether the read holds a server value. */
      held(): boolean;
      readonly seen: CommitSeen;
    };

/** What one holder's server data says of one op. */
export type HolderVerdict = "confirmed" | "needs" | "irrelevant";

const EMPTY_OPS: readonly PredictOp[] = Object.freeze([]);

/** A value tuple's canonical params as one string (sorted keys). */
export function valueParamsKey(
  params: Readonly<Record<string, string>>,
): string {
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .map((k) => [k, params[k]]),
  );
}

/** The ops that still apply to `tupleKey` and touch `subject`, in dispatch order. */
export function applicableOps(
  ops: readonly PredictOp[],
  tupleKey: string,
  subject: string,
): readonly PredictOp[] {
  if (ops.length === 0) return EMPTY_OPS;
  const out = ops.filter(
    (op) => op.subjects.has(subject) && !op.retired.has(tupleKey),
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
 * Whether `row` can be judged against a where-target's filter: it carries
 * every column the filter names. A read whose rows lack one cannot tell (a
 * negative op would read the missing value as NULL and match), so the target
 * leaves it to the server's frame.
 */
function matchesWhere(
  t: Extract<ResolvedLiveTarget, { kind: "where" }>,
  row: PredictRow,
): boolean {
  for (const c of filterColumns(t.filter)) if (!(c in row)) return false;
  return matchesFilter(row, t.filter, t.filterable);
}

/** An order field's value as the filter language compares it (an instant as epoch ms). */
function orderScalar(v: unknown): FilterScalar | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean")
    return v;
  throw new Error(
    `predict overlay: an order field holds ${JSON.stringify(v)} — a read is ordered by scalar fields.`,
  );
}

/** `a` vs `b` in `order` (NULLS LAST either way), the id ascending last. */
function compareInOrder(
  order: PredictOrder,
  idField: string,
  a: PredictRow,
  b: PredictRow,
): number {
  for (const [field, dir] of order) {
    const x = orderScalar(a[field]);
    const y = orderScalar(b[field]);
    if (x === y) continue;
    if (x === null) return 1;
    if (y === null) return -1;
    const c = compareScalars(x, y);
    if (c !== 0) return dir === "desc" ? -c : c;
  }
  return compareScalars(String(a[idField]), String(b[idField]));
}

/** Whether a prediction moved `next` in `order` relative to its server row. */
function orderMoved(
  order: PredictOrder,
  server: PredictRow,
  next: PredictRow,
): boolean {
  return order.some(
    ([field]) => orderScalar(server[field]) !== orderScalar(next[field]),
  );
}

/**
 * A tuple's server rows with every op applying to it folded in, in dispatch
 * order: a `row` target patches, removes or upserts its row (an absent one
 * entering only a read that admits it), a `rows` target reduces the held rows
 * it names, a `where` target rewrites every held row matching its filter;
 * then, when the collection declares its `membership`, every row a prediction
 * changed that no longer matches it is dropped, and, when the read is
 * ordered, every row a prediction moved in the order is placed again among
 * the unmoved ones (leaving the read when it lands past the last held row of
 * a read with `more`).
 *
 * Returns `rows` itself when nothing changes — so a read no op touches keeps
 * its data's identity (consumers memoize on it).
 */
export function predictRows(
  ops: readonly PredictOp[],
  tuple: PredictTuple,
  rows: readonly PredictRow[],
): readonly PredictRow[] {
  const { tupleKey, subject, idField, membership, entrant, order } = tuple;
  const apply = applicableOps(ops, tupleKey, subject);
  if (apply.length === 0) return rows;
  let work: (PredictRow | undefined)[] | null = null;
  const indexOf = new Map<string, number>();
  rows.forEach((r, i) => indexOf.set(String(r[idField]), i));
  // Upserted rows the server rows do not hold, by id, in entry order.
  const entered = new Map<string, PredictRow>();
  const current = (i: number): PredictRow | undefined =>
    work === null ? rows[i] : work[i];
  const write = (i: number, row: PredictRow | undefined): void => {
    if (row === current(i)) return;
    work ??= [...rows];
    work[i] = row;
  };
  /** Apply `f` to the row `id` wherever this read holds it. */
  const update = (
    id: string,
    f: (row: PredictRow) => PredictRow | undefined,
  ): void => {
    const i = indexOf.get(id);
    if (i !== undefined) {
      const row = current(i);
      if (row === undefined) return;
      const next = f(row);
      write(i, next === undefined ? undefined : keepShape(rows[i]!, next));
      return;
    }
    const row = entered.get(id);
    if (row === undefined) return;
    const next = f(row);
    if (next === undefined) entered.delete(id);
    else entered.set(id, keepShape(row, next));
  };
  const held = (): PredictRow[] => {
    const out: PredictRow[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = current(i);
      if (row !== undefined) out.push(row);
    }
    out.push(...entered.values());
    return out;
  };
  for (const op of apply) {
    for (const t of op.targets) {
      if (t.subject !== subject) continue;
      switch (t.kind) {
        case "row": {
          const known = indexOf.has(t.id) || entered.has(t.id);
          if (known) {
            update(t.id, (row) => t.apply(row));
          } else if (t.enters && entrant !== undefined) {
            const next = t.apply(undefined);
            const shaped = next === undefined ? undefined : entrant(next);
            if (shaped !== undefined) entered.set(t.id, shaped);
          }
          break;
        }
        case "rows": {
          const mine = new Set(t.ids);
          const hit = held().filter((r) => mine.has(String(r[idField])));
          if (hit.length === 0) break;
          const out = new Map(t.apply(hit).map((r) => [String(r[idField]), r]));
          for (const r of hit) {
            const id = String(r[idField]);
            update(id, () => out.get(id));
          }
          break;
        }
        case "where": {
          for (const r of held()) {
            if (matchesWhere(t, r)) update(String(r[idField]), t.apply);
          }
          break;
        }
        case "value":
          // A value's subject is never a row read's.
          break;
      }
    }
  }
  if (work === null && entered.size === 0) return rows;
  const changed: readonly (PredictRow | undefined)[] = work ?? rows;
  const inMembership = (row: PredictRow): boolean =>
    membership === undefined ||
    matchesFilter(row, membership.filter, membership.filterable);
  const stay: PredictRow[] = [];
  const moving: PredictRow[] = [];
  changed.forEach((row, i) => {
    if (row === undefined) return;
    if (row === rows[i]) {
      stay.push(row);
      return;
    }
    if (!inMembership(row)) return;
    if (order !== undefined && orderMoved(order, rows[i]!, row)) {
      moving.push(row);
    } else {
      stay.push(row);
    }
  });
  for (const row of entered.values()) {
    if (inMembership(row)) moving.push(row);
  }
  if (moving.length === 0) return stay;
  if (order === undefined) return [...stay, ...moving];
  const out = stay;
  for (const row of moving) {
    let at = out.findIndex((r) => compareInOrder(order, idField, row, r) < 0);
    if (at === -1) {
      // Past every held row: in a read with more rows beyond, it has left
      // what this read holds — the server's frame brings it where it lands.
      if (tuple.more === true) continue;
      at = out.length;
    }
    out.splice(at, 0, row);
  }
  return out;
}

/**
 * One row of a tuple with the ops folded in (`predictRows` over the row, or
 * over none — an upsert may make an absent row exist): `undefined` when it
 * is absent, removed, or moved out of the collection's `membership`.
 */
export function predictRow(
  ops: readonly PredictOp[],
  tuple: PredictTuple,
  row: PredictRow | undefined,
): PredictRow | undefined {
  const out = predictRows(ops, tuple, row === undefined ? [] : [row]);
  return out[0];
}

/**
 * Whether an op still applying to `tupleKey` targets row `id` (`row`: the
 * server's, which a filter-targeted op is matched against) — `useLiveRow`'s
 * `pending`.
 */
export function rowPending(
  ops: readonly PredictOp[],
  tupleKey: string,
  subject: string,
  id: string,
  row: PredictRow | undefined,
): boolean {
  return applicableOps(ops, tupleKey, subject).some((op) =>
    op.targets.some((t) => {
      if (t.subject !== subject) return false;
      switch (t.kind) {
        case "row":
          return t.id === id;
        case "rows":
          return t.ids.includes(id);
        case "where":
          return row !== undefined && matchesWhere(t, row);
        case "value":
          return false;
      }
    }),
  );
}

/**
 * A value tuple's server value with every op applying to it folded in, in
 * dispatch order — `value` itself when none does.
 */
export function predictValue(
  ops: readonly PredictOp[],
  tupleKey: string,
  subject: string,
  key: string,
  paramsKey: string,
  value: unknown,
): unknown {
  let out = value;
  for (const op of applicableOps(ops, tupleKey, subject)) {
    for (const t of op.targets) {
      if (
        t.kind === "value" &&
        t.key === key &&
        valueParamsKey(t.params) === paramsKey
      ) {
        out = t.apply(out);
      }
    }
  }
  return out;
}

/** Whether an op still applying to a value tuple targets it — the read's `pending`. */
export function valuePending(
  ops: readonly PredictOp[],
  tupleKey: string,
  subject: string,
  key: string,
  paramsKey: string,
): boolean {
  return applicableOps(ops, tupleKey, subject).some((op) =>
    op.targets.some(
      (t) =>
        t.kind === "value" &&
        t.key === key &&
        valueParamsKey(t.params) === paramsKey,
    ),
  );
}

/** Whether a target is confirmed by its write's commit (it compares nothing). */
export function confirmedByCommit(t: ResolvedLiveTarget): boolean {
  return t.kind !== "row" || t.confirmedBy === null;
}

/** A causally-confirmed target's verdict on a holder that holds it. */
function byCommit(
  op: PredictOp,
  seen: CommitSeen,
): Exclude<HolderVerdict, "irrelevant"> {
  if (op.ackedAt === undefined) return "needs";
  // An ack naming no commit — a host that cannot attribute one: the ack is
  // the only evidence there is.
  if (op.commits === undefined || op.commits.length === 0) return "confirmed";
  return seen(op.commits) ? "confirmed" : "needs";
}

/**
 * What a holder's server data says of `op` (see the header): any target the
 * tuple still needs wins, then any it confirms; a tuple holding none of the
 * op's targets is irrelevant to it.
 */
export function holderVerdict(
  op: PredictOp,
  holder: PredictHolder,
): HolderVerdict {
  if (holder.kind === "value") {
    if (!holder.held()) return "irrelevant";
    const targeted = op.targets.some(
      (t) =>
        t.kind === "value" &&
        t.key === holder.key &&
        valueParamsKey(t.params) === holder.paramsKey,
    );
    return targeted ? byCommit(op, holder.seen) : "irrelevant";
  }
  const rows = holder.rows();
  if (rows === undefined) return "irrelevant";
  const byId = (id: string): PredictRow | undefined =>
    rows.find((r) => String(r[holder.idField]) === id);
  let confirmed = false;
  for (const t of op.targets) {
    if (t.subject !== holder.subject) continue;
    let verdict: HolderVerdict = "irrelevant";
    switch (t.kind) {
      case "row": {
        const server = byId(t.id);
        if (server === undefined) {
          if (t.removes) {
            // A removal the tuple already shows.
            verdict = "confirmed";
          } else if (t.enters && holder.entrant !== undefined) {
            // An upsert this read admits but the server has not sent: it
            // applies until the tuple's frames have seen its commit (then the
            // server's absence is its answer).
            const next = t.apply(undefined);
            if (next !== undefined && holder.entrant(next) !== undefined) {
              verdict = byCommit(op, holder.seen);
            }
          }
          // Any other target has nothing here to apply to.
          break;
        }
        if (t.confirmedBy === null) {
          verdict = byCommit(op, holder.seen);
          break;
        }
        // A field this collection does not carry cannot disagree: it is read
        // as the predicted value, so only the carried ones are compared.
        verdict = t.confirmedBy(fillMissing(server, t.set))
          ? "confirmed"
          : "needs";
        break;
      }
      case "rows":
        if (t.ids.some((id) => byId(id) !== undefined)) {
          verdict = byCommit(op, holder.seen);
        }
        break;
      case "where":
        if (rows.some((r) => matchesWhere(t, r))) {
          verdict = byCommit(op, holder.seen);
        }
        break;
      case "value":
        break;
    }
    if (verdict === "needs") return "needs";
    if (verdict === "confirmed") confirmed = true;
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
  /** The ops touching `subject` — one stable array while they do not change. */
  opsFor(subject: string): readonly PredictOp[];
  op(opId: string): PredictOp | undefined;
  /** Add a dispatched op; `onDone` runs once, when it is DONE (never on removal). */
  add(op: PredictOp, onDone: PredictDone): void;
  /** Replace an op (a stamp, a failure); a no-op once it left. */
  update(opId: string, change: (op: PredictOp) => PredictOp): void;
  /** Drop an op without completing it (a permanent rejection). */
  remove(opId: string): void;
  /** Register a mounted read; returns its unregistration (which sweeps). */
  register(holder: PredictHolder): () => void;
  /** Whether a mounted read of `subject` holds tuple `tupleKey` (it is observed). */
  holding(subject: string, tupleKey: string): boolean;
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
  const bySubject = new Map<
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
      for (const subject of op.subjects) {
        for (const holder of holders.get(subject) ?? []) {
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
    opsFor(subject) {
      const cached = bySubject.get(subject);
      if (cached !== undefined && cached.from === ops) return cached.ops;
      const fresh = ops.filter((op) => op.subjects.has(subject));
      // Keep the previous array while its ops are the same objects, so a
      // read of a subject no change touched keeps its snapshot.
      const prev = cached?.ops;
      const same =
        prev !== undefined &&
        prev.length === fresh.length &&
        prev.every((op, i) => op === fresh[i]);
      const result = same ? prev : fresh.length === 0 ? EMPTY_OPS : fresh;
      bySubject.set(subject, { from: ops, ops: result });
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
    holding(subject, tupleKey) {
      for (const h of holders.get(subject) ?? []) {
        if (h.tupleKey === tupleKey) return true;
      }
      return false;
    },
    register(holder) {
      let set = holders.get(holder.subject);
      if (set === undefined) {
        set = new Set();
        holders.set(holder.subject, set);
      }
      set.add(holder);
      return () => {
        const s = holders.get(holder.subject);
        s?.delete(holder);
        if (s?.size === 0) holders.delete(holder.subject);
        // A holder leaving may be the last one an acked op waited on.
        sweep();
      };
    },
    sweep,
  };
}
