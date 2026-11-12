import { and, eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  MIRROR_PAGE_MAX_ROWS,
  type MirrorChangesPage,
  type MirrorChangesRequest,
  type MirrorCopyPage,
  type MirrorCopyRequest,
  type MirrorKeyedRow,
  type MirrorKeysPage,
  type MirrorKeysRequest,
  type MirrorPk,
  type MirrorRefusal,
  type MirrorRowsAnswer,
  type MirrorRowsRequest,
  type SourceIdentity,
  type TableFingerprints,
} from "@plugins/database/plugins/table-mirror/core";
import type {
  MirroredTable,
  MirrorSetDefinition,
} from "@plugins/database/plugins/table-mirror/plugins/source/server";
import { keyText, type Exec, type KeyHash, type ReplicaTx } from "./exec";
import { applyToKeyIndex, keyIndexHashes, pruneKeyIndex } from "./key-index";
import { REPLICA_CHANNEL, type ReplicaNotice } from "./notify";
import {
  applyToSchema,
  mirrorColumns,
  prepareSchema,
  type PreparedSink,
  schemaKeyHashes,
  SourceOlderError,
} from "./schema-sink";
import type {
  ReconcileReason,
  ReplicaOutcome,
  ReplicaPhase,
  ReplicaProgress,
} from "./state";
import { tableMirrorReplicas } from "./tables";

// ── The contract with the owner ──────────────────────────────────────────────

/** A transport failure, as the transport gave it: recorded, never interpreted. */
export interface MirrorFetchFailed {
  kind: "fetch-failed";
  failure: unknown;
}

/**
 * How a replica reaches its source: one call per page. The replica is
 * transport-agnostic — site-mirror passes an SSH curl, a test the source's
 * readers called in-process.
 */
export interface MirrorFetch {
  changes(
    req: MirrorChangesRequest,
  ): Promise<MirrorChangesPage | MirrorRefusal | MirrorFetchFailed>;
  copy(
    req: MirrorCopyRequest,
  ): Promise<MirrorCopyPage | MirrorRefusal | MirrorFetchFailed>;
  keys(
    req: MirrorKeysRequest,
  ): Promise<MirrorKeysPage | MirrorRefusal | MirrorFetchFailed>;
  rows(
    req: MirrorRowsRequest,
  ): Promise<MirrorRowsAnswer | MirrorRefusal | MirrorFetchFailed>;
}

/** One table's part of an applied page. */
export interface MirrorSinkBatch {
  table: string;
  upserts: readonly MirrorKeyedRow[];
  deletes: readonly MirrorPk[];
}

/**
 * A sink of the owner's own, in place of the replica's schema (site-reports'
 * reduce step): handed every applied page in the page's transaction, beside
 * the cursor. The replica keeps the key index for it, and hands it only the
 * upserts whose row hash the index did not hold — each row content once, a
 * re-delivery never (tombstones are all handed). `reconciling`: the rows come
 * from a reconciliation (they changed while deltas could not say so);
 * `firstCopy`: from the replica's first sync (its copy, then the stream that
 * catches it up).
 */
export interface MirrorCustomSink {
  apply(
    tx: ReplicaTx,
    batch: readonly MirrorSinkBatch[],
    opts: { reconciling: boolean; firstCopy: boolean },
  ): Promise<void>;
}

export interface PullReplicaOptions {
  db: NodePgDatabase;
  replicaId: string;
  /** The set the replica copies (its id must be the replica's). */
  set: MirrorSetDefinition;
  fetch: MirrorFetch;
  /** Required exactly for a replica created with `sink: "custom"`. */
  sink?: MirrorCustomSink;
  /** How many fetches this pull may make: one bounded chunk; pull again while not `caughtUp`. */
  budget: { pages: number };
  /** Page bounds asked of the source (its defaults otherwise). */
  bounds?: { maxRows?: number; maxBytes?: number; maxKeys?: number };
}

export interface PullResult {
  phase: ReplicaPhase;
  outcome: ReplicaOutcome;
  /** The change stream reached `done`: the copy is as fresh as the source's last page. */
  caughtUp: boolean;
}

/** Another pull of the same replica committed meanwhile: two pulls must never interleave. */
export class ConcurrentPullError extends Error {
  constructor(replicaId: string) {
    super(
      `table-mirror: replica ${replicaId} was changed by another pull while this one ran — pulls of one replica must be serialized (the owner's job dedups per replica)`,
    );
    this.name = "ConcurrentPullError";
  }
}

// ── The engine ───────────────────────────────────────────────────────────────

type ReplicaRow = typeof tableMirrorReplicas.$inferSelect;
type ReplicaPatch = Partial<
  Omit<typeof tableMirrorReplicas.$inferInsert, "id" | "seq">
>;

/** What one sink kind does; the engine never asks which kind it has. */
interface Sink {
  /** Bring the local side in line with the set. */
  prepare(tx: ReplicaTx): Promise<PreparedSink>;
  /** The columns the copy holds of `t`: what a keys / rows request asks for. */
  columns(exec: Exec, t: MirroredTable): Promise<string[]>;
  apply(
    tx: ReplicaTx,
    batch: readonly MirrorSinkBatch[],
    opts: { reconciling: boolean; firstCopy: boolean },
  ): Promise<void>;
  keyHashes(
    exec: Exec,
    t: MirroredTable,
    columns: readonly string[],
    afterPk: MirrorPk | null,
    lastPk: MirrorPk | null,
  ): Promise<KeyHash[]>;
}

function sinkOf(
  row: ReplicaRow,
  set: MirrorSetDefinition,
  custom: MirrorCustomSink | undefined,
): Sink {
  const table = (name: string) => set.tables.find((t) => t.name === name)!;
  if (row.sink === "schema") {
    const schema = row.schemaName;
    if (schema === null) {
      throw new Error(`table-mirror: schema replica ${row.id} has no schema`);
    }
    if (custom !== undefined) {
      throw new Error(
        `table-mirror: replica ${row.id} keeps its own schema; a custom sink was passed`,
      );
    }
    return {
      prepare: (tx) => prepareSchema(tx, schema, set),
      columns: (exec, t) => mirrorColumns(exec, schema, t),
      async apply(tx, batch) {
        for (const b of batch) {
          await applyToSchema(tx, schema, table(b.table), b.upserts, b.deletes);
        }
      },
      keyHashes: (exec, t, columns, afterPk, lastPk) =>
        schemaKeyHashes(exec, schema, t, columns, afterPk, lastPk),
    };
  }
  if (custom === undefined) {
    throw new Error(
      `table-mirror: replica ${row.id} has a custom sink; none was passed`,
    );
  }
  return {
    async prepare(tx) {
      await pruneKeyIndex(
        tx,
        row.id,
        set.tables.map((t) => t.name),
      );
      return { changed: [], emptied: false };
    },
    columns: async (_exec, t) => [...t.columns],
    async apply(tx, batch, opts) {
      // The sink is handed each row content once: a re-delivered row (same
      // hash as the index holds) is left out, so a sink that counts what it
      // is handed (site-reports' recurrences) never counts one twice.
      const handed: MirrorSinkBatch[] = [];
      for (const b of batch) {
        const upserts = await applyToKeyIndex(
          tx,
          row.id,
          table(b.table),
          b.upserts,
          b.deletes,
        );
        handed.push({ table: b.table, upserts, deletes: b.deletes });
      }
      await custom.apply(tx, handed, opts);
    },
    keyHashes: (exec, t, _columns, afterPk, lastPk) =>
      keyIndexHashes(exec, row.id, t, afterPk, lastPk),
  };
}

/** Sorted-key JSON: equal values, equal text. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

interface Header {
  identity: SourceIdentity;
  fingerprints: TableFingerprints;
  xmin: string;
  now: string;
}

/** What a page's header says about the pass it belongs to. */
function judgeHeader(
  row: ReplicaRow,
  header: Header,
): "adopt" | "same" | ReconcileReason {
  if (row.sourceIdentity === null) return "adopt";
  if (canonical(row.sourceIdentity) !== canonical(header.identity)) {
    return "source-identity";
  }
  if (canonical(row.fingerprints) !== canonical(header.fingerprints)) {
    return "source-fingerprints";
  }
  return "same";
}

type Step =
  | { kind: "continue"; row: ReplicaRow }
  | { kind: "stop"; row: ReplicaRow; outcome: ReplicaOutcome };

/**
 * One bounded chunk of a replica's sync: at most `budget.pages` fetches, each
 * page applied with the cursor and the phase it moves in ONE transaction (so
 * a killed pull resumes where it stopped), each committing with a NOTIFY on
 * `table_mirror`. A replica in phase `empty` copies (the only full copy); a
 * live one reads the change stream; one whose deltas cannot be trusted —
 * `reconcile-required`, another source identity or epoch, a fingerprint
 * change on the source, a table created or rebuilt here — reconciles by key
 * and row hash, fetching only the rows that differ and deleting the keys the
 * source no longer has. The outcome is recorded on the replica row; a
 * refusal or transport failure is an outcome, never a throw.
 */
export async function pullReplica(
  opts: PullReplicaOptions,
): Promise<PullResult> {
  const { db, replicaId, set, fetch } = opts;
  const bounds = opts.bounds ?? {};
  let row = await loadReplica(db, replicaId);
  if (row.setId !== set.id) {
    throw new Error(
      `table-mirror: replica ${replicaId} copies set "${row.setId}", not "${set.id}"`,
    );
  }
  const sink = sinkOf(row, set, opts.sink);
  const tables = set.tables.map((t) => t.name);
  let pages = 0;
  let caughtUp = false;

  const commit = (
    from: ReplicaRow,
    patch: ReplicaPatch,
    work?: (tx: ReplicaTx) => Promise<void>,
  ) => commitStep(db, set.id, from, patch, work);

  const startTables = (
    from: ReplicaRow,
    phase: "copying" | "reconciling",
    reason: ReconcileReason | null,
  ) =>
    commit(from, {
      phase,
      progress: {
        stage: "tables",
        table: tables[0]!,
        afterPk: null,
        tablesDone: 0,
        total: tables.length,
        rows: 0,
        deleted: 0,
        reason,
      },
      localTables: tables,
      sourceIdentity: null,
      fingerprints: null,
      floor: null,
      after: null,
      passXmin: null,
    });
  const reconcile = (from: ReplicaRow, reason: ReconcileReason) =>
    startTables(from, "reconciling", reason);

  /** The next tables-stage progress after a page that ended at `lastPk`. */
  const advance = (
    p: Extract<ReplicaProgress, { stage: "tables" }>,
    done: boolean,
    lastPk: MirrorPk | null,
    rows: number,
    deleted: number,
  ): ReplicaProgress => {
    const counts = { rows: p.rows + rows, deleted: p.deleted + deleted };
    if (!done) return { ...p, ...counts, afterPk: lastPk };
    const next = tables[tables.indexOf(p.table) + 1];
    if (next === undefined) return { stage: "stream", reason: p.reason };
    return {
      ...p,
      ...counts,
      table: next,
      afterPk: null,
      tablesDone: p.tablesDone + 1,
    };
  };

  const fetched = <T>(answer: T): T => {
    pages += 1;
    return answer;
  };

  async function copyStep(
    from: ReplicaRow,
    p: Extract<ReplicaProgress, { stage: "tables" }>,
  ): Promise<Step> {
    const page = fetched(
      await fetch.copy({
        setId: set.id,
        table: p.table,
        afterPk: p.afterPk,
        maxRows: bounds.maxRows,
        maxBytes: bounds.maxBytes,
      }),
    );
    if (page.kind !== "copy")
      return { kind: "stop", row: from, outcome: failed(page) };
    const judged = judgeHeader(from, page);
    if (judged !== "adopt" && judged !== "same") {
      // The source changed under the copy: what was copied may be stale in
      // ways the stream from this floor cannot say.
      return { kind: "continue", row: await reconcile(from, judged) };
    }
    const next = await commit(
      from,
      {
        ...(judged === "adopt" ? adopted(page) : {}),
        progress: advance(p, page.done, page.lastPk, page.rows.length, 0),
        sourceNow: page.now,
      },
      (tx) =>
        sink.apply(tx, [{ table: p.table, upserts: page.rows, deletes: [] }], {
          reconciling: false,
          firstCopy: true,
        }),
    );
    return { kind: "continue", row: next };
  }

  async function reconcileStep(
    from: ReplicaRow,
    p: Extract<ReplicaProgress, { stage: "tables" }>,
  ): Promise<Step> {
    const t = set.tables.find((x) => x.name === p.table)!;
    const columns = await sink.columns(db, t);
    const page = fetched(
      await fetch.keys({
        setId: set.id,
        table: t.name,
        columns,
        afterPk: p.afterPk,
        maxKeys: bounds.maxKeys,
      }),
    );
    if (page.kind !== "keys")
      return { kind: "stop", row: from, outcome: failed(page) };
    const judged = judgeHeader(from, page);
    if (judged !== "adopt" && judged !== "same") {
      return { kind: "continue", row: await reconcile(from, judged) };
    }
    const local = await inUtc(db, (tx) =>
      sink.keyHashes(
        tx,
        t,
        page.columns,
        p.afterPk,
        page.done ? null : page.lastPk,
      ),
    );
    const theirs = new Map(page.keys.map((k) => [keyText(k.pk), k]));
    const ours = new Map(local.map((k) => [keyText(k.pk), k]));
    const deletes: MirrorPk[] = local
      .filter((k) => !theirs.has(keyText(k.pk)))
      .map((k) => k.pk);
    const queue: MirrorPk[] = page.keys
      .filter((k) => ours.get(keyText(k.pk))?.h !== k.h)
      .map((k) => k.pk);
    const upserts: MirrorKeyedRow[] = [];
    const chunk = Math.min(
      bounds.maxRows ?? MIRROR_PAGE_MAX_ROWS,
      MIRROR_PAGE_MAX_ROWS,
    );
    // One keys page commits as one transaction, so its rows are fetched in
    // full first (several requests when they pass a page's bounds).
    while (queue.length > 0) {
      const pks = queue.splice(0, chunk);
      const answer = fetched(
        await fetch.rows({
          setId: set.id,
          table: t.name,
          columns,
          pks,
          maxBytes: bounds.maxBytes,
        }),
      );
      if (answer.kind !== "rows") {
        return { kind: "stop", row: from, outcome: failed(answer) };
      }
      const again = judgeHeader(
        { ...from, ...(judged === "adopt" ? adopted(page) : {}) },
        answer,
      );
      if (again !== "same") {
        // `adopt` cannot happen here (the keys page was adopted above).
        return {
          kind: "continue",
          row: await reconcile(
            from,
            again === "adopt" ? "source-identity" : again,
          ),
        };
      }
      if (answer.rows.length + answer.missing.length === 0) {
        throw new Error(
          `table-mirror: the source answered none of ${pks.length} keys of ${t.name} (all past its byte cap) — it must take the first`,
        );
      }
      upserts.push(...answer.rows);
      // Gone since the keys page: the stream from the floor carries their
      // tombstones too; deleting them now is the same answer, sooner.
      deletes.push(...answer.missing);
      queue.unshift(...answer.remaining);
    }
    const next = await commit(
      from,
      {
        ...(judged === "adopt" ? adopted(page) : {}),
        progress: advance(
          p,
          page.done,
          page.lastPk,
          upserts.length,
          deletes.length,
        ),
        sourceNow: page.now,
      },
      (tx) =>
        sink.apply(tx, [{ table: t.name, upserts, deletes }], {
          reconciling: true,
          firstCopy: false,
        }),
    );
    return { kind: "continue", row: next };
  }

  async function streamStep(from: ReplicaRow): Promise<Step> {
    if (from.floor === null || from.sourceIdentity === null) {
      throw new Error(
        `table-mirror: replica ${replicaId} reached the change stream with no floor — a copy or reconcile pass read no page`,
      );
    }
    const page = fetched(
      await fetch.changes({
        setId: set.id,
        cursor: { floor: from.floor, after: from.after },
        maxRows: bounds.maxRows,
        maxBytes: bounds.maxBytes,
      }),
    );
    if (page.kind === "reconcile-required") {
      return { kind: "continue", row: await reconcile(from, "behind-horizon") };
    }
    if (page.kind !== "changes")
      return { kind: "stop", row: from, outcome: failed(page) };
    const judged = judgeHeader(from, page);
    if (judged !== "same") {
      // `adopt` cannot happen (the identity is set): name it as what it is.
      return {
        kind: "continue",
        row: await reconcile(
          from,
          judged === "adopt" ? "source-identity" : judged,
        ),
      };
    }
    const byTable = new Map<
      string,
      { upserts: MirrorKeyedRow[]; deletes: MirrorPk[] }
    >(tables.map((t) => [t, { upserts: [], deletes: [] }]));
    for (const c of page.changes) {
      // A table the source mirrors and this install does not (a newer
      // source): nothing here reads it.
      const b = byTable.get(c.tbl);
      if (b === undefined) continue;
      if (c.kind === "tombstone") b.deletes.push(c.pk);
      else b.upserts.push({ pk: c.pk, h: c.h, row: c.row });
    }
    const batch = [...byTable]
      .filter(([, b]) => b.upserts.length + b.deletes.length > 0)
      .map(([table, b]) => ({ table, ...b }));
    const passXmin = from.passXmin ?? page.xmin;
    const patch: ReplicaPatch = page.done
      ? {
          floor: passXmin,
          after: null,
          passXmin: null,
          phase: "live",
          progress: null,
          sourceNow: page.now,
          lastSyncedAt: new Date(),
          // The copy is whole from here on: readers may read it.
          copiedAt: from.copiedAt ?? new Date(),
        }
      : { after: page.next.after, passXmin, sourceNow: page.now };
    const next = await commit(from, patch, (tx) =>
      sink.apply(tx, batch, {
        reconciling: from.phase === "reconciling",
        firstCopy: from.phase === "copying",
      }),
    );
    if (page.done) {
      caughtUp = true;
      return { kind: "stop", row: next, outcome: { kind: "synced" } };
    }
    return { kind: "continue", row: next };
  }

  let outcome: ReplicaOutcome = { kind: "stopped" };
  try {
    // The local side first: a table created or rebuilt here holds rows the
    // stream cannot vouch for, so it is reconciled.
    let changed: string[] = [];
    row = await commit(row, {}, async (tx) => {
      const prepared = await sink.prepare(tx);
      changed = prepared.changed;
      if (prepared.emptied) {
        // A rebuilt table lost its rows: not the data until reconciled.
        await tx
          .update(tableMirrorReplicas)
          .set({ copiedAt: null })
          .where(eq(tableMirrorReplicas.id, replicaId));
      }
    });
    const known = new Set(row.localTables ?? []);
    const added = tables.filter((t) => !known.has(t));
    if (row.phase !== "empty" && (changed.length > 0 || added.length > 0)) {
      row = await reconcile(row, "local-schema");
    }
    // A table the set no longer lists, named by the pass in progress (a
    // release removed it mid-pass): the pass cannot continue from it.
    if (
      row.progress?.stage === "tables" &&
      !tables.includes(row.progress.table)
    ) {
      row = await reconcile(row, "local-schema");
    }
    for (;;) {
      if (pages >= opts.budget.pages) break;
      let step: Step;
      if (row.phase === "empty") {
        step = {
          kind: "continue",
          row: await startTables(row, "copying", null),
        };
      } else if (row.progress?.stage === "tables") {
        step =
          row.phase === "copying"
            ? await copyStep(row, row.progress)
            : await reconcileStep(row, row.progress);
      } else {
        step = await streamStep(row);
      }
      row = step.row;
      if (step.kind === "stop") {
        outcome = step.outcome;
        break;
      }
    }
  } catch (err) {
    if (!(err instanceof SourceOlderError)) throw err;
    outcome = {
      kind: "source-older",
      table: err.table,
      columns: [...err.columns],
    };
  }
  await db
    .update(tableMirrorReplicas)
    .set({ lastAttemptAt: new Date(), lastOutcome: outcome })
    .where(eq(tableMirrorReplicas.id, replicaId));
  return { phase: row.phase, outcome, caughtUp };
}

function failed(answer: MirrorRefusal | MirrorFetchFailed): ReplicaOutcome {
  return answer.kind === "fetch-failed"
    ? { kind: "fetch-failed", failure: answer.failure }
    : { kind: "refused", refusal: answer };
}

/** A pass's first page: its source, and the floor its stream starts from. */
function adopted(page: Header): ReplicaPatch {
  return {
    sourceIdentity: page.identity,
    fingerprints: page.fingerprints,
    floor: page.xmin,
  };
}

async function loadReplica(
  db: NodePgDatabase,
  replicaId: string,
): Promise<ReplicaRow> {
  const [row] = await db
    .select()
    .from(tableMirrorReplicas)
    .where(eq(tableMirrorReplicas.id, replicaId));
  if (row === undefined) {
    throw new Error(
      `table-mirror: no replica ${replicaId} (ensureReplica first)`,
    );
  }
  return row;
}

/** A read under `TimeZone = 'UTC'`, as the row hash requires. */
async function inUtc<T>(
  db: NodePgDatabase,
  fn: (tx: ReplicaTx) => Promise<T>,
): Promise<T> {
  return db.transaction(
    async (tx) => {
      await tx.execute(sql.raw(`SET LOCAL TimeZone = 'UTC'`));
      return fn(tx);
    },
    { accessMode: "read only" },
  );
}

/**
 * One step's transaction: the replica row moved on (`seq` guards against a
 * second pull), the sink's work, and the NOTIFY — all or nothing.
 */
async function commitStep(
  db: NodePgDatabase,
  setId: string,
  from: ReplicaRow,
  patch: ReplicaPatch,
  work?: (tx: ReplicaTx) => Promise<void>,
): Promise<ReplicaRow> {
  return db.transaction(async (tx) => {
    await tx.execute(sql.raw(`SET LOCAL TimeZone = 'UTC'`));
    const [next] = await tx
      .update(tableMirrorReplicas)
      .set({ ...patch, seq: sql`${tableMirrorReplicas.seq} + 1` })
      .where(
        and(
          eq(tableMirrorReplicas.id, from.id),
          eq(tableMirrorReplicas.seq, from.seq),
        ),
      )
      .returning();
    if (next === undefined) throw new ConcurrentPullError(from.id);
    if (work !== undefined) await work(tx);
    const notice: ReplicaNotice = { replicaId: from.id, setId };
    await tx.execute(
      sql`SELECT pg_notify(${REPLICA_CHANNEL}, ${JSON.stringify(notice)})`,
    );
    return next;
  });
}
