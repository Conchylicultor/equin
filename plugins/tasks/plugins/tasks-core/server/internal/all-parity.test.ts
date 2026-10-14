/**
 * Parity of the `all` compiler with the views it replaces (P8 v3 step 16b.5;
 * v2's "Full ≡ `tasks_v` / `attempts_v`, and scoped(S) ≡ full∩S, under
 * `SET TIME ZONE 'Europe/Paris'`"): the compiled whole set of tasks — two
 * children joins over attempts (each with the two rollups nested), the
 * dependency list, and the blocking closure whose ancestors carry their own
 * attempts — and of attempts — the two rollups joined row-wise, plus a
 * `jsonAgg` of each attempt's conversations — and of active conversations
 * (the owner joins, two REQUIRED lookups, C5) equal the
 * derived views row for row, on a seeded graph with cycles, holds, drops, waiting, gone and
 * system conversations, before and after a round of writes the rollup
 * triggers maintain.
 *
 * Since step 19 the tasks half is the SHIPPED declaration — `taskRows`
 * compiled with its real serve options (`./task-rows.ts`) — against `tasks_v`
 * rebuilt on the same builders (`./derived.ts`): the two readers of one
 * definition, held equal row for row. Both read "waiting" off the conversation
 * rollup's `has_waiting_conv`. Since step 20 the attempts half is the shipped
 * `attemptRows` too (`./attempt-rows.ts`), against `attempts_v`, and since
 * step 22 the active conversations are the shipped `conversationsActive`
 * (`./conversation-rows.ts`), against `conversations_v`.
 *
 * Every comparison runs in a transaction pinned to Europe/Paris, so a
 * timestamptz rendered on the server (the `jsonAgg`'s ISO text) or decoded on
 * the client cannot pass by happening to run in UTC.
 *
 * Run: `./singularity test plugins/tasks/plugins/tasks-core` (requires the
 * running embedded cluster — `./singularity build` first).
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { attemptRows, conversationsActive, taskRows } from "../../core";
import { installTaskDerivedSchema } from "../testing/install-derived-schema";
import { conversationsActiveServeOptions } from "./conversation-rows";
import { attemptRowsServeOptions } from "./attempt-rows";
import { taskRowsServeOptions } from "./task-rows";
import { _conversations } from "./tables";
import { attempts, conversations, tasks } from "./views";

setDefaultTimeout(180_000);

// ── The declarations ────────────────────────────────────────────────────────

type Rec = Record<string, unknown>;

/** The shipped `tasks` set (`taskRows`), compiled with its real serve options. */
function compileTasks(db: QueryDb) {
  return compileCollection(taskRows, { ...taskRowsServeOptions, db });
}

/** The shipped `attempts` set (`attemptRows`), compiled with its real serve options. */
function compileAttempts(db: QueryDb) {
  return compileCollection(attemptRows, { ...attemptRowsServeOptions, db });
}

/**
 * The shipped `conversations-active` set (`conversationsActive`, step 22 —
 * C5: `all` over `_conversations` with the owner joins, two REQUIRED
 * lookups, and a membership `where`), compiled with its real serve options.
 */
function compileActiveConversations(db: QueryDb) {
  return compileCollection(conversationsActive, {
    ...conversationsActiveServeOptions,
    db,
  });
}

// ── The fixture ──────────────────────────────────────────────────────────────

let t: TestDb;

function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}
const rand = prng(1958);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
let clock = Date.parse("2026-03-29T00:30:00.000Z"); // a DST change in Paris
const instant = (): string => {
  clock += 1000 + Math.floor(rand() * 7_200_000);
  return new Date(clock).toISOString();
};

const taskIds: string[] = [];
const attemptIds: string[] = [];
let seq = 0;

async function seed(db: NodePgDatabase, n: number): Promise<void> {
  const fresh: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = `task-${++seq}`;
    const r = rand();
    await db.execute(sql`
      INSERT INTO tasks (id, title, rank, held_at, dropped_at, created_at)
      VALUES (${id}, ${`title ${id}`}, ${`a${String(seq).padStart(4, "0")}`},
              ${r < 0.15 ? instant() : null}::timestamptz,
              ${r > 0.85 ? instant() : null}::timestamptz,
              ${instant()}::timestamptz)`);
    taskIds.push(id);
    fresh.push(id);
  }
  for (const taskId of fresh) {
    const k = Math.floor(rand() * 4);
    for (let a = 0; a < k; a++) {
      const id = `att-${++seq}`;
      await db.execute(sql`
        INSERT INTO attempts (id, task_id, worktree_path, created_at)
        VALUES (${id}, ${taskId}, ${`/tmp/${id}`}, ${instant()}::timestamptz)`);
      attemptIds.push(id);
      const c = Math.floor(rand() * 4);
      for (let i = 0; i < c; i++) {
        const status = pick(["starting", "working", "waiting", "gone", "done"]);
        const kind = rand() < 0.15 ? "system" : pick(["user", "agent"]);
        const created = instant();
        await db.execute(sql`
          INSERT INTO conversations (id, attempt_id, status, model, kind, title, created_at, ended_at, spawned_by)
          VALUES (${`conv-${++seq}`}, ${id}, ${status}, ${FALLBACK_MODEL}, ${kind},
                  ${rand() < 0.2 ? null : `conv title ${seq}`}, ${created}::timestamptz,
                  ${status === "done" ? instant() : null}::timestamptz,
                  ${rand() < 0.3 ? `conv-${seq - 1}` : null})`);
      }
      if (rand() < 0.4) {
        for (let p = 0; p < 1 + Math.floor(rand() * 2); p++) {
          const pid = `push-${++seq}`;
          await db.execute(sql`
            INSERT INTO pushes (id, attempt_id, sha, push_id, message, created_at)
            VALUES (${pid}, ${id}, ${`sha-${pid}`}, ${`pid-${pid}`}, ${"msg"}, ${instant()}::timestamptz)`);
        }
      }
    }
  }
  for (let e = 0; e < n; e++) {
    await db.execute(sql`
      INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
      VALUES (${pick(taskIds)}, ${pick(taskIds)}, ${instant()}::timestamptz)
      ON CONFLICT DO NOTHING`);
  }
}

beforeAll(async () => {
  t = await createTestDb({ prefix: "all_parity" });
  await runMigrations(t.db);
  // The rollups and the views, as a backend installs them.
  await installTaskDerivedSchema(t.db);
  await seed(t.db, 40);
  // A cycle through three tasks, and a chain hanging off it.
  const [a, b, c, d] = taskIds;
  for (const [x, y] of [
    [a, b],
    [b, c],
    [c, a],
    [d, a],
  ] as const) {
    await t.db.execute(sql`
      INSERT INTO task_dependencies (task_id, depends_on_task_id, created_at)
      VALUES (${x!}, ${y!}, ${instant()}::timestamptz) ON CONFLICT DO NOTHING`);
  }
});

afterAll(async () => {
  await t?.drop();
});

// ── The comparisons ──────────────────────────────────────────────────────────

/** Run `fn` in a transaction whose session time zone is Europe/Paris. */
async function inParis<T>(
  fn: (db: QueryDb, raw: NodePgDatabase) => Promise<T>,
): Promise<T> {
  return t.db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL TIME ZONE 'Europe/Paris'`);
    const [zone] = await executeRows(tx, {
      query: sql`SELECT current_setting('TimeZone') AS tz`,
      row: z.object({ tz: z.string() }),
      label: "tz",
    });
    expect(zone!.tz).toBe("Europe/Paris");
    return fn(tx as unknown as QueryDb, tx as unknown as NodePgDatabase);
  });
}

const json = (rows: readonly unknown[]): Rec[] =>
  JSON.parse(JSON.stringify(rows)) as Rec[];
const byId = (a: Rec, b: Rec) => (String(a.id) < String(b.id) ? -1 : 1);
const sortedById = (rows: readonly unknown[]): Rec[] => json(rows).sort(byId);
/** Rows without their exposed fields (`$columns`). */
const ownRows = (rows: readonly unknown[]): Rec[] =>
  (rows as Rec[]).map(({ $columns: _c, ...rest }) => rest as Rec);

async function checkTasks(): Promise<number> {
  return inParis(async (db, raw) => {
    const compiled = compileTasks(db);
    // The set reaches the tasks extensions' exposures (`from`); none is
    // served here, so every row's `$columns` is empty — the rest is the
    // view's row.
    const loaded = (await compiled.all.loader({})) as Rec[];
    expect(loaded.map((r) => r.$columns)).toEqual(loaded.map(() => ({})));
    const full = ownRows(loaded);
    // `tasks_v` minus `description`: the set's row is `TaskListItem`.
    const view = (await raw.select().from(tasks)).map(
      ({ description: _d, ...rest }) => rest,
    );
    expect(sortedById(full)).toEqual(sortedById(view));
    // The declared order: rank, then createdAt, the id the tiebreaker — as
    // Postgres orders them (rank is text under the column's collation).
    const order = (
      await executeRows(raw, {
        query: sql`SELECT id FROM tasks_v ORDER BY rank, created_at, id`,
        row: z.object({ id: z.string() }),
        label: "order",
      })
    ).map((r) => r.id);
    expect(json(full).map((r) => r.id)).toEqual(order);
    const policy = compiled.all as unknown as {
      scopedMembership: { orderOf(p: object): Promise<string[]> };
    };
    expect(await policy.scopedMembership.orderOf({})).toEqual(
      order as string[],
    );
    // scoped(S) ≡ full ∩ S, with an id that is no task's.
    for (let i = 0; i < 6; i++) {
      const s = [
        ...new Set([
          ...Array.from({ length: 1 + Math.floor(rand() * 8) }, () =>
            pick(taskIds),
          ),
          "task-none",
        ]),
      ];
      const scoped = await compiled.all.loader({}, { affectedIds: s });
      const want = json(full).filter((r) => s.includes(String(r.id)));
      expect(sortedById(ownRows(scoped))).toEqual(want.sort(byId));
      const point = await compiled.rows.loader({ ids: s.join(",") });
      expect(sortedById(ownRows(point))).toEqual(want.sort(byId));
    }
    return full.length;
  });
}

async function checkAttempts(): Promise<number> {
  return inParis(async (db, raw) => {
    const compiled = compileAttempts(db);
    const full = (await compiled.all.loader({})) as Rec[];
    const view = await raw.select().from(attempts);
    const withoutList = full.map(({ conversations: _c, ...rest }) => rest);
    expect(sortedById(withoutList)).toEqual(sortedById(view));
    // The jsonAgg: each attempt's non-system conversations, created order,
    // timestamps as the ISO text a `Date` crosses the wire as.
    const convRows = await raw
      .select({
        id: _conversations.id,
        attemptId: _conversations.attemptId,
        title: _conversations.title,
        status: _conversations.status,
        kind: _conversations.kind,
        createdAt: _conversations.createdAt,
        spawnedBy: _conversations.spawnedBy,
      })
      .from(_conversations);
    const listOf = (attemptId: string) =>
      convRows
        .filter((c) => c.attemptId === attemptId && c.kind !== "system")
        .sort(
          (x, y) =>
            x.createdAt.getTime() - y.createdAt.getTime() ||
            (x.id < y.id ? -1 : 1),
        )
        .map((c) => ({
          id: c.id,
          title: c.title,
          status: c.status,
          kind: c.kind,
          createdAt: c.createdAt.toISOString(),
          spawnedBy: c.spawnedBy,
        }));
    for (const row of full) {
      expect({ id: row.id, list: row.conversations }).toEqual({
        id: row.id,
        list: listOf(String(row.id)),
      });
    }
    for (let i = 0; i < 4; i++) {
      const s = [
        ...new Set([
          ...Array.from({ length: 1 + Math.floor(rand() * 8) }, () =>
            pick(attemptIds),
          ),
          "att-none",
        ]),
      ];
      const scoped = await compiled.all.loader({}, { affectedIds: s });
      const want = json(full).filter((r) => s.includes(String(r.id)));
      expect(sortedById(scoped)).toEqual(want.sort(byId));
    }
    return full.length;
  });
}

async function checkActiveConversations(): Promise<number> {
  return inParis(async (db, raw) => {
    const compiled = compileActiveConversations(db);
    const loaded = (await compiled.all.loader({})) as Rec[];
    // The set reaches its task's exposures (`exposes`); none is served here,
    // so every row's `$columns` is empty — the rest is the view's row.
    expect(loaded.map((r) => r.$columns)).toEqual(loaded.map(() => ({})));
    const full = loaded.map(({ $columns: _c, ...rest }) => rest as Rec);
    const view = (await raw.select().from(conversations)).filter(
      (c) => c.status !== "done" && c.kind !== "system",
    );
    expect(sortedById(full)).toEqual(sortedById(view));
    // The declared order: `createdAt` newest first, the id (ascending) the
    // tiebreaker.
    const order = json(view)
      .sort(
        (x, y) =>
          String(y.createdAt).localeCompare(String(x.createdAt)) || byId(x, y),
      )
      .map((r) => r.id);
    expect(json(full).map((r) => r.id)).toEqual(order);
    // The lookups' reverse routes probe the real tables: a task write reaches
    // every conversation of the task (through attempts, never `tasks` — A10),
    // an attempt write every conversation of the attempt.
    const routes = compiled.all.routes!.routes;
    const probe = async (id: string, key: string): Promise<string[]> => {
      const route = routes.find((r) => r.id === id)!;
      if (route.map.kind !== "reverse")
        throw new Error(`${id} is not a reverse route`);
      const hosts = await route.map.resolve([key], null, 10_000);
      if (hosts === "over-cap") throw new Error("over-cap");
      return [...hosts].sort();
    };
    const all = await raw.select().from(conversations);
    for (const taskId of taskIds.slice(0, 6)) {
      expect(await probe("task", taskId)).toEqual(
        all
          .filter((c) => c.taskId === taskId)
          .map((c) => c.id)
          .sort(),
      );
    }
    for (const attemptId of attemptIds.slice(0, 6)) {
      expect(await probe("attempt", attemptId)).toEqual(
        all
          .filter((c) => c.attemptId === attemptId)
          .map((c) => c.id)
          .sort(),
      );
    }
    const s = all.slice(0, 7).map((c) => String(c.id));
    const scoped = await compiled.all.loader(
      {},
      { affectedIds: [...s, "conv-none"] },
    );
    expect(sortedById(scoped)).toEqual(
      json(loaded)
        .filter((r) => s.includes(String(r.id)))
        .sort(byId),
    );
    return full.length;
  });
}

describe("the `all` compiler ≡ the derived views (Europe/Paris)", () => {
  test("tasks ≡ tasks_v, attempts ≡ attempts_v, on the seeded graph", async () => {
    expect(await checkTasks()).toBe(taskIds.length);
    expect(await checkAttempts()).toBe(attemptIds.length);
    expect(await checkActiveConversations()).toBeGreaterThan(5);
    // The seed covers what the CASEs branch on.
    const statuses = await t.db.execute(
      sql`SELECT DISTINCT status FROM tasks_v ORDER BY 1`,
    );
    expect(statuses.rows.length).toBeGreaterThanOrEqual(5);
  });

  test("…and again after writes the rollup triggers maintain", async () => {
    // Status moves, a push, a reparented attempt, a dropped and a held
    // task, a deleted attempt (cascading its conversations and pushes),
    // a deleted edge, more of everything.
    await t.db.execute(sql`
      UPDATE conversations SET status = 'done', ended_at = now()
       WHERE id IN (SELECT id FROM conversations ORDER BY id LIMIT 5)`);
    await t.db.execute(sql`
      UPDATE conversations SET status = 'waiting'
       WHERE id IN (SELECT id FROM conversations ORDER BY id DESC LIMIT 4)`);
    await t.db.execute(sql`
      INSERT INTO pushes (id, attempt_id, sha, push_id, message, created_at)
      VALUES ('push-x', ${attemptIds[0]!}, 'sha-x', 'pid-x', 'msg', ${instant()}::timestamptz)`);
    await t.db.execute(sql`
      UPDATE attempts SET task_id = ${taskIds[5]!} WHERE id = ${attemptIds[1]!}`);
    await t.db.execute(
      sql`UPDATE tasks SET dropped_at = now() WHERE id = ${taskIds[2]!}`,
    );
    await t.db.execute(
      sql`UPDATE tasks SET held_at = now() WHERE id = ${taskIds[3]!}`,
    );
    await t.db.execute(sql`DELETE FROM attempts WHERE id = ${attemptIds[2]!}`);
    attemptIds.splice(2, 1);
    await t.db.execute(sql`
      DELETE FROM task_dependencies
       WHERE (task_id, depends_on_task_id) IN (SELECT task_id, depends_on_task_id FROM task_dependencies ORDER BY 1, 2 LIMIT 2)`);
    await seed(t.db, 10);
    expect(await checkTasks()).toBe(taskIds.length);
    expect(await checkAttempts()).toBe(attemptIds.length);
    expect(await checkActiveConversations()).toBeGreaterThan(5);
  });
});
