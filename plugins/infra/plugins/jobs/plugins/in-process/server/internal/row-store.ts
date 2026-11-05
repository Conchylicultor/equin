import { eq } from "drizzle-orm";
import { db, type DbExecutor } from "@plugins/database/server";
import type { HoldClass } from "@plugins/infra/plugins/jobs/core";
import type { JobTaskPayload } from "@plugins/infra/plugins/jobs/server";
import { _inProcessJobRows, _inProcessJobSchedules } from "./tables";

/** A queued row as it outlives the process: everything but whether it runs now. */
export interface StoredRow {
  id: string;
  hold: HoldClass;
  payload: JobTaskPayload;
  jobKey: string | null;
  runAt: Date;
  attempts: number;
  maxAttempts: number;
  dead: boolean;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** What a previous process left: its rows, and each schedule's last tick. */
export interface StoredQueue {
  rows: StoredRow[];
  lastExecutions: ReadonlyMap<string, Date>;
}

/**
 * Where the in-process queue's rows outlive this process. The queue keeps its
 * working copy in memory and writes every change of a row here, in order per
 * row; `insert` with a transaction writes inside it, so the row commits or rolls
 * back with the caller's writes.
 */
export interface RowStore {
  load(): Promise<StoredQueue>;
  insert(row: StoredRow, tx?: DbExecutor): Promise<void>;
  /** Write the row's mutable state (payload, key, due time, attempts, outcome). */
  update(row: StoredRow): Promise<void>;
  remove(id: string): Promise<void>;
  /** Record that the schedule of `jobName` ticked at `at`. */
  recordTick(jobName: string, at: Date): Promise<void>;
}

/**
 * The rows in the host's own database (`jobs_in_process_rows`,
 * `jobs_in_process_schedules`): what the queue the host provides persists to,
 * so they last exactly as long as the data whose derived rows they bring up to
 * date — a browser host's IndexedDB, a test's in-memory PGlite.
 */
export function databaseRowStore(): RowStore {
  return {
    async load() {
      const rows = await db
        .select()
        .from(_inProcessJobRows)
        .orderBy(_inProcessJobRows.createdAt);
      const ticks = await db.select().from(_inProcessJobSchedules);
      return {
        rows: rows.map((r) => ({
          id: r.id,
          hold: r.hold,
          payload: { ...r.payload, input: r.payload.input },
          jobKey: r.jobKey,
          runAt: r.runAt,
          attempts: r.attempts,
          maxAttempts: r.maxAttempts,
          dead: r.dead,
          lastError: r.lastError,
          createdAt: r.createdAt,
          updatedAt: r.changedAt,
        })),
        lastExecutions: new Map(ticks.map((t) => [t.jobName, t.lastExecution])),
      };
    },
    async insert(row, tx) {
      await (tx ?? db).insert(_inProcessJobRows).values({
        id: row.id,
        jobName: row.payload.jobName,
        hold: row.hold,
        payload: row.payload,
        jobKey: row.jobKey,
        runAt: row.runAt,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        dead: row.dead,
        lastError: row.lastError,
        createdAt: row.createdAt,
        changedAt: row.updatedAt,
      });
    },
    async update(row) {
      await db
        .update(_inProcessJobRows)
        .set({
          payload: row.payload,
          jobName: row.payload.jobName,
          hold: row.hold,
          jobKey: row.jobKey,
          runAt: row.runAt,
          attempts: row.attempts,
          maxAttempts: row.maxAttempts,
          dead: row.dead,
          lastError: row.lastError,
          changedAt: row.updatedAt,
        })
        .where(eq(_inProcessJobRows.id, row.id));
    },
    async remove(id) {
      await db.delete(_inProcessJobRows).where(eq(_inProcessJobRows.id, id));
    },
    async recordTick(jobName, at) {
      await db
        .insert(_inProcessJobSchedules)
        .values({ jobName, lastExecution: at })
        .onConflictDoUpdate({
          target: _inProcessJobSchedules.jobName,
          set: { lastExecution: at },
        });
    },
  };
}

/**
 * Rows kept in a plain map — a store that outlives one queue but not the
 * process: what a test hands two queues in turn to stand for a reload. `tx` is
 * ignored (no database), so a rollback is not modelled here.
 */
export function memoryRowStore(): RowStore {
  const rows = new Map<string, StoredRow>();
  const ticks = new Map<string, Date>();
  return {
    async load() {
      return {
        rows: [...rows.values()]
          .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
          .map((r) => ({ ...r })),
        lastExecutions: new Map(ticks),
      };
    },
    async insert(row) {
      rows.set(row.id, { ...row });
    },
    async update(row) {
      if (rows.has(row.id)) rows.set(row.id, { ...row });
    },
    async remove(id) {
      rows.delete(id);
    },
    async recordTick(jobName, at) {
      ticks.set(jobName, at);
    },
  };
}
