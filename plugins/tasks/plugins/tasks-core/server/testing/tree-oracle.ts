import { getTableName, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type { FeedChange } from "@plugins/database/plugins/change-feed/server";
import {
  createChangeFeedListener,
  createChangeRouter,
  rebuildTriggers,
} from "@plugins/database/plugins/change-feed/server/testing";
import {
  createResourceRuntime,
  type PersistMeta,
  type ResourceRuntime,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  makeClientView,
  type ClientView,
  type RecordedFrame,
} from "@plugins/framework/plugins/resource-runtime/core/testing";
import type {
  LiveAllCollection,
  LiveCollection,
  LiveLookupCollection,
} from "@plugins/network/plugins/live/core";
import type {
  AllCollectionSpecs,
  CollectionSpecs,
  LookupCollectionSpecs,
} from "@plugins/network/plugins/live/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import { installDerivedUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import type { Rollup } from "@plugins/database/plugins/derived-tables/core";
import { installRollups } from "@plugins/database/plugins/derived-tables/server/testing";
import { attemptConvAgg, attemptPushAgg } from "../internal/rollup-spec";
import { tasksCoreDerivedUpdatedAt } from "../internal/tables";
import { installTaskDerivedSchema } from "./install-derived-schema";

// The TREE ORACLE harness (P8 v3, steps 18–22; v2 *Verification*: "real
// triggers; at quiescence every client view equals a fresh FULL"). One
// throwaway database with the real migration chain and this plugin's derived
// layer (rollups, views and the derived `updated_at` triggers), the change-feed's routed triggers installed from the routes the
// registered entries declared, its LISTEN consumer, the feed's own routing
// (`createChangeRouter`) and a resource runtime with L2 hooks for the
// persisted keys — so an `all` set behaves exactly as it ships: a persisted
// routed alias, its `{}` snapshot kept current with nobody subscribed.
//
// The runtime is the harness's OWN (`createResourceRuntime`), never
// server-core's process-global one: `./singularity test` runs every bun suite
// in one process, and a suite that imports a plugin's server barrel (directly
// or through a chain — conversations' auto-start → lifecycle →
// `setTaskCategory`) registers that plugin's real keys on the global registry
// at module eval. Registering the same key on the global runtime here would
// then throw `defineResource: duplicate key` — so the oracle registers, routes,
// subscribes and reads its kept snapshots on a runtime nothing else can reach.
//
// A suite registers the REAL declarations compiled against the throwaway
// (`compileCollection(c, { ...realServeOptions, db: oracle.queryDb })` —
// network/live's `server/testing`), subscribes the tuples its surfaces read,
// and drives the tree workload (`treeSeed` / `treeSteps`, extended with its
// own statements through `withSteps`). After every step `converged()` holds
// each subscribed view against a fresh FULL load of its tuple, and the step's
// cost (loads per key, `orderOf` calls) is returned for the suite's own
// per-step assertions. Each conversion step (18 `task-categories`, 19 `tasks`,
// 20 `attempts`, 21 `agent-launches`, 22 the conversation lists) adds its
// entry and its cases; the entry's owner plugin runs it (an owner downstream
// of tasks-core — task-category, agents — cannot be imported from here). A
// rollup such an owner declares over the tree tables (agents'
// `task_latest_conversation`) is handed in as `rollups`, installed beside
// this plugin's own.
//
// Each harness is self-contained (its own database, listener, router and
// runtime), so two may coexist in one process.

/** One loader call: the ids a scoped refill asked for, or `"FULL"`. */
export interface TreeLoad {
  ids: readonly string[] | "FULL";
}

/** What one step cost, per registered key. */
export interface TreeStepCost {
  loads: Record<string, TreeLoad[]>;
  orderOf: Record<string, number>;
}

/** One scripted write: SQL run in order on one connection, then settled. */
export interface TreeStep {
  label: string;
  statements: readonly string[];
}

interface Registered {
  key: string;
  /** The tuple's truth: a fresh FULL load, parsed. */
  full(params: Record<string, string>): Promise<unknown>;
  keyOf(row: unknown): string;
  /** A point read's order is not the set's: compared by key. */
  point: boolean;
}

interface Subscribed {
  entry: Registered;
  params: Record<string, string>;
  view: ClientView;
  from: number;
}

export interface TreeOracle {
  readonly db: NodePgDatabase;
  /** The drizzle handle compiled entries load through (`compileCollection`'s `db`). */
  readonly queryDb: NodePgDatabase;
  /**
   * The harness's own resource runtime — what a suite hands a helper that
   * drives a runtime (`subscribeAsOldDescriptor`'s `handler`:
   * `oracle.runtime.notificationsWsHandler`).
   */
  readonly runtime: ResourceRuntime;
  /**
   * Register an `all` collection's compiled specs (its `key` and `key:rows`)
   * on the harness's runtime, with their loads and `orderOf` calls counted —
   * a scoped one (`all: { by }`) too, each subscribed tuple's truth then a
   * fresh FULL load of its scope. Before `start()`: the triggers are
   * installed from the routes registered by then.
   */
  registerAll<Row, B extends string = never>(
    collection: LiveAllCollection<Row, B>,
    specs: AllCollectionSpecs<Row, B>,
  ): void;
  /**
   * Register a lookup-only collection's compiled `key:rows` point spec, its
   * loads counted — the per-id read beside an `all` set (`taskDescriptions`).
   * Before `start()`, like `registerAll`.
   */
  registerLookup<Row>(
    collection: LiveLookupCollection<Row>,
    specs: LookupCollectionSpecs,
  ): void;
  /**
   * Register a WINDOW collection's compiled window spec (`key`) and its
   * `key:rows` point spec, their loads counted — a bounded list beside the
   * `all` sets (`conversationsGone`). A window tuple's truth is a fresh FULL
   * load of its params, compared in order. Before `start()`, like
   * `registerAll`.
   */
  registerWindow<Row, F, S extends string>(
    collection: LiveCollection<Row, F, S>,
    specs: CollectionSpecs,
  ): void;
  /** Install the triggers, start the feed, open the socket. */
  start(): Promise<void>;
  subscribe(key: string, params?: Record<string, string>): Promise<void>;
  unsubscribe(key: string, params?: Record<string, string>): void;
  /** Run one step's statements and wait until the runtime is quiet; its cost. */
  run(step: TreeStep): Promise<TreeStepCost>;
  /**
   * Every subscribed view equals a fresh FULL load of its tuple, and every
   * persisted key's kept `{}` snapshot does too — a persisted key that was
   * ever subscribed MUST hold one (a missing kept snapshot is the L2 hazard
   * the oracle exists to catch, never a pass). Throws naming the first that
   * differs (and the step label it is called with). Also throws when the
   * runtime reported a failure (a loader, a drain, a persist) since the last
   * call.
   */
  converged(label: string): Promise<void>;
  /**
   * What a subscribed tuple's client view holds now (every frame so far
   * applied) — for a suite asserting the TRUTH it converged to is the case it
   * means to exercise (a window at capacity actually evicting), not only that
   * the view equals it. Throws for a tuple that is not subscribed.
   */
  view(key: string, params?: Record<string, string>): unknown;
  /** The kept `{}` snapshot of a persisted key (L2's source). */
  kept(key: string): unknown;
  /** Every load of `key` so far. */
  loadsOf(key: string): readonly TreeLoad[];
  /** Every persist of `key` so far, with its mode. */
  persistsOf(key: string): readonly { value: unknown; meta: PersistMeta }[];
  stop(): Promise<void>;
}

export interface TreeOracleOptions {
  /** The throwaway database's name prefix. */
  prefix: string;
  /** Keys the L2 hooks persist (the `preload: "boot"` `all` sets). */
  persisted: readonly string[];
  /**
   * Rollups an owner downstream of tasks-core declares over the tree tables
   * (agents' `task_latest_conversation`), installed beside this plugin's own
   * through the boot rollup path (`installRollups`) and feed-exempt like
   * them: their sources carry the routes.
   */
  rollups?: readonly Rollup[];
}

/** JSON with sorted keys, so a row compares by content whatever its key order. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x !== null && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.entries(x as Record<string, unknown>).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : x,
  );
}

const QUIET_MS = 150;
const DEADLINE_MS = 10_000;

async function until(cond: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + DEADLINE_MS;
  while (!cond()) {
    if (Date.now() > deadline)
      throw new Error(`tree oracle timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

export async function createTreeOracle(
  options: TreeOracleOptions,
): Promise<TreeOracle> {
  const testDb: TestDb = await createTestDb({ prefix: options.prefix });
  const client = new Client({ connectionString: testDb.connectionString });
  await client.connect();
  const db = drizzle(client);
  await runMigrations(testDb.db);
  await installTaskDerivedSchema(testDb.db);
  // Re-installed together with this plugin's own, as one boot installs every
  // declared rollup: the per-table trigger signatures then cover them all.
  const extraRollups = options.rollups ?? [];
  if (extraRollups.length > 0) {
    await installRollups(testDb.db, [
      attemptConvAgg,
      attemptPushAgg,
      ...extraRollups,
    ]);
  }
  // The derived `updated_at` triggers too, as a backend installs them at
  // boot: a write a row field does not read can still move `updatedAt` (a
  // task's description), and the oracle must cost it as production does.
  await installDerivedUpdatedAt(
    testDb.db,
    Object.values(tasksCoreDerivedUpdatedAt).filter(
      (spec) => spec !== undefined,
    ),
  );

  const persisted = new Set(options.persisted);
  const registered = new Map<string, Registered>();
  const loads = new Map<string, TreeLoad[]>();
  const orderOf = new Map<string, number>();
  const persists = new Map<string, { value: unknown; meta: PersistMeta }[]>();
  const routed: FeedChange[] = [];
  const frames: RecordedFrame[] = [];
  const subscribed = new Map<string, Subscribed>();
  let seq = 0;
  let listener: ReturnType<typeof createChangeFeedListener> | null = null;
  let started = false;

  // A persisted key once subscribed must keep a snapshot from then on.
  const expectKept = new Set<string>();
  // What the runtime reported (console.error fires too): surfaced by the next
  // `converged()`, so a failed refill or persist fails the step it happened in.
  const failures: string[] = [];

  const runtime = createResourceRuntime({
    shouldPersist: (key) => persisted.has(key),
    captureWatermark: async () => {
      const res = await db.execute<{ xmin: string }>(
        sql`SELECT pg_snapshot_xmin(pg_current_snapshot())::text AS xmin`,
      );
      return res.rows[0]!.xmin;
    },
    persistSnapshot: async (key, _pk, value, _watermark, meta) => {
      const list = persists.get(key) ?? [];
      list.push({ value, meta });
      persists.set(key, list);
    },
    reportError: (context, err) => {
      failures.push(
        `${context}: ${err instanceof Error ? err.message : String(err)}`,
      );
    },
  });
  const routeChange = createChangeRouter(runtime);

  const handler = runtime.notificationsWsHandler as unknown as {
    open(ws: unknown): void;
    message(ws: unknown, raw: string): void;
    close(ws: unknown, code: number, reason: string): void;
  };
  const ws = {
    send(raw: string) {
      const frame = JSON.parse(raw) as Omit<RecordedFrame, "seq" | "socket">;
      if (frame.kind !== "ping")
        frames.push({ ...frame, seq: seq++, socket: 0 });
    },
  };

  const counted = (key: string) => {
    loads.set(key, []);
    return (ctx: { affectedIds: Iterable<string> } | undefined) =>
      loads.get(key)!.push({ ids: ctx ? [...ctx.affectedIds].sort() : "FULL" });
  };

  const tupleId = (key: string, params: Record<string, string>) =>
    `${key}\0${JSON.stringify(params)}`;

  function viewValue(s: Subscribed): unknown {
    const params = JSON.stringify(s.params);
    s.view.applyAll(
      frames
        .slice(s.from)
        .filter(
          (f) =>
            f.key === s.entry.key && JSON.stringify(f.params ?? {}) === params,
        ),
    );
    s.from = frames.length;
    return s.view.value;
  }

  function byKey(entry: Registered, rows: unknown): unknown {
    if (!entry.point) return rows;
    return [...(rows as unknown[])].sort((a, b) => {
      const ka = entry.keyOf(a);
      const kb = entry.keyOf(b);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
  }

  const snapshot = () =>
    [
      routed.length,
      frames.length,
      ...[...loads.values()].map((l) => l.length),
      ...orderOf.values(),
    ].join(",");

  async function settle(from: number, label: string): Promise<void> {
    await until(
      () => routed.length > from,
      () => `step "${label}" routed no change`,
    );
    const deadline = Date.now() + DEADLINE_MS;
    for (;;) {
      const at = snapshot();
      await new Promise((r) => setTimeout(r, QUIET_MS));
      if (snapshot() === at) return;
      if (Date.now() > deadline) {
        throw new Error(
          `tree oracle: the runtime never went quiet after "${label}"`,
        );
      }
    }
  }

  /** A collection's `:rows` point spec, its loads counted; its row key. */
  function registerRows<Row>(
    collection: {
      key: string;
      id: string;
      rows: LiveAllCollection<Row>["rows"];
    },
    rows: AllCollectionSpecs<Row>["rows"],
  ): (row: unknown) => string {
    const rowsKey = collection.rows.key;
    const rowsLoad = counted(rowsKey);
    runtime.defineResource(collection.rows, {
      ...rows,
      loader: (p, ctx) => {
        rowsLoad(ctx);
        return rows.loader(p, ctx);
      },
    } as typeof rows);
    const keyOf = (row: unknown) =>
      String((row as Record<string, unknown>)[collection.id]);
    registered.set(rowsKey, {
      key: rowsKey,
      full: async (p) => {
        const ids = p.ids;
        if (ids === undefined) {
          throw new Error(`tree oracle: a ${rowsKey} tuple without ids`);
        }
        return collection.rows.schema.parse(await rows.loader({ ids }));
      },
      keyOf,
      point: true,
    });
    return keyOf;
  }

  return {
    db,
    queryDb: db,
    runtime,

    registerAll(collection, specs) {
      if (started) throw new Error("tree oracle: register before start()");
      const all = specs.all;
      const membership = all.scopedMembership;
      if (membership === undefined) {
        throw new Error(
          `tree oracle: ${collection.key} is not a routed alias (no scopedMembership)`,
        );
      }
      const key = collection.key;
      const allLoad = counted(key);
      orderOf.set(key, 0);
      // The compiled options with the loader and `orderOf` counted — the same
      // policy arm (`routes` + `scopedMembership`), so the cast only restates it.
      runtime.defineResource(collection.all, {
        ...all,
        loader: (p, ctx) => {
          allLoad(ctx);
          return all.loader(p, ctx);
        },
        scopedMembership: {
          ...membership,
          orderOf: (p) => {
            orderOf.set(key, orderOf.get(key)! + 1);
            return membership.orderOf(p);
          },
        },
      } as typeof all);
      const keyOf = registerRows(collection, specs.rows);
      registered.set(key, {
        key,
        // The whole set has one tuple, `{}`; a scoped set one per scope.
        full: async (p) =>
          collection.all.schema.parse(
            await all.loader(p as Parameters<typeof all.loader>[0]),
          ),
        keyOf,
        point: false,
      });
    },

    registerLookup(collection, specs) {
      if (started) throw new Error("tree oracle: register before start()");
      // A lookup's `:rows` is a point SPEC (what `serveCollection` hands
      // `windowQueryResource`), compiled here to the runtime options.
      registerRows(
        collection,
        compileWindowQuery(collection.rows, specs.rows).serverOpts,
      );
    },

    registerWindow(collection, specs) {
      if (started) throw new Error("tree oracle: register before start()");
      // Its specs as `serveCollection` hands them to `windowQueryResource`,
      // compiled here to the runtime options.
      const window = compileWindowQuery(
        collection.window,
        specs.window,
      ).serverOpts;
      const key = collection.key;
      const windowLoad = counted(key);
      runtime.defineResource(collection.window, {
        ...window,
        loader: (p, ctx) => {
          windowLoad(ctx);
          return window.loader(p, ctx);
        },
      } as typeof window);
      const keyOf = registerRows(
        collection,
        compileWindowQuery(collection.rows, specs.rows).serverOpts,
      );
      registered.set(key, {
        key,
        full: async (p) =>
          collection.window.schema.parse(await window.loader(p as never)),
        keyOf,
        point: false,
      });
    },

    async start() {
      started = true;
      // Rollup tables are derived (feed-exempt in production): their sources
      // carry the routes.
      const feedExempt = new Set(
        [attemptConvAgg, attemptPushAgg, ...extraRollups].map((r) =>
          getTableName(r.handle),
        ),
      );
      await rebuildTriggers(
        testDb.db,
        { feedExempt, optedOut: new Set(), produced: new Set() },
        runtime.routedTableRequirements(),
      );
      const tables = (
        await testDb.db.execute<{ t: string }>(
          sql`SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public'`,
        )
      ).rows.map((r) => r.t);
      listener = createChangeFeedListener({
        connectionString: () => testDb.connectionString,
        route: (change) => {
          routed.push(change);
          routeChange(change);
        },
        coveredTables: () => tables,
        livenessIntervalMs: 60_000,
      });
      listener.start();
      const deadline = Date.now() + DEADLINE_MS;
      for (;;) {
        const res = await testDb.db.execute(
          sql`SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database()
                AND query LIKE 'LISTEN live_state%'
                AND pid <> pg_backend_pid()`,
        );
        if (res.rows.length > 0) break;
        if (Date.now() > deadline) {
          throw new Error("tree oracle: timed out waiting for LISTEN");
        }
        await new Promise((r) => setTimeout(r, 20));
      }
      handler.open(ws);
    },

    async subscribe(key, params = {}) {
      const entry = registered.get(key);
      if (entry === undefined) {
        throw new Error(`tree oracle: ${key} is not registered`);
      }
      const from = frames.length;
      handler.message(ws, JSON.stringify({ op: "sub", key, params }));
      await until(
        () =>
          frames.slice(from).some((f) => f.kind === "sub-ack" && f.key === key),
        () => `sub-ack ${key}`,
      );
      if (persisted.has(key)) expectKept.add(key);
      subscribed.set(tupleId(key, params), {
        entry,
        params,
        view: makeClientView(entry.keyOf),
        from,
      });
    },

    unsubscribe(key, params = {}) {
      handler.message(ws, JSON.stringify({ op: "unsub", key, params }));
      subscribed.delete(tupleId(key, params));
    },

    async run(step) {
      const at = {
        routed: routed.length,
        loads: new Map([...loads].map(([k, l]) => [k, l.length])),
        orderOf: new Map(orderOf),
      };
      for (const statement of step.statements) {
        await db.execute(sql.raw(statement));
      }
      await settle(at.routed, step.label);
      return {
        loads: Object.fromEntries(
          [...loads].map(([k, l]) => [k, l.slice(at.loads.get(k) ?? 0)]),
        ),
        orderOf: Object.fromEntries(
          [...orderOf].map(([k, n]) => [k, n - (at.orderOf.get(k) ?? 0)]),
        ),
      };
    },

    async converged(label) {
      if (failures.length > 0) {
        const reported = failures.splice(0);
        throw new Error(
          `tree oracle: by "${label}" the runtime reported ${reported.length} failure(s):\n  ${reported.join("\n  ")}`,
        );
      }
      for (const s of subscribed.values()) {
        const got = canonical(byKey(s.entry, viewValue(s)));
        const want = canonical(byKey(s.entry, await s.entry.full(s.params)));
        if (got !== want) {
          throw new Error(
            `tree oracle: after "${label}", ${s.entry.key} ${JSON.stringify(s.params)} is not a fresh FULL load\n  view: ${got}\n  full: ${want}`,
          );
        }
      }
      for (const key of persisted) {
        const entry = registered.get(key);
        if (entry === undefined) continue;
        const kept = runtime.keptSnapshotValue(key);
        if (kept === undefined) {
          if (!expectKept.has(key)) continue;
          throw new Error(
            `tree oracle: no kept snapshot for ${key} after "${label}" — a persisted alias that was subscribed must keep its \`{}\` snapshot`,
          );
        }
        const got = canonical(kept);
        const want = canonical(await entry.full({}));
        if (got !== want) {
          throw new Error(
            `tree oracle: after "${label}", the kept snapshot of ${key} is not a fresh FULL load\n  kept: ${got}\n  full: ${want}`,
          );
        }
      }
    },

    view(key, params = {}) {
      const s = subscribed.get(tupleId(key, params));
      if (s === undefined) {
        throw new Error(
          `tree oracle: ${key} ${JSON.stringify(params)} is not subscribed`,
        );
      }
      return viewValue(s);
    },

    kept: (key) => runtime.keptSnapshotValue(key),
    loadsOf: (key) => loads.get(key) ?? [],
    persistsOf: (key) => persists.get(key) ?? [],

    async stop() {
      handler.close(ws, 1000, "tree oracle");
      runtime.dropPendingPersists();
      await listener?.stop();
      await client.end();
      await testDb.drop();
    },
  };
}

// ── The tree workload ───────────────────────────────────────────────────────
//
// Reactor-inert rows (title_auto false; no conversation a poller would act on
// in a throwaway anyway) over the five tree tables. Ids are fixed so a suite
// extending the script can name them. The edges form a chain T3 → T2 → T1
// plus T4 → T1 (a task "runs after" what it depends on); T6 joins later.

/** The tree workload's ids, for suites interleaving their own statements. */
export const TREE_IDS = {
  tasks: ["tree-t1", "tree-t2", "tree-t3", "tree-t4", "tree-t5", "tree-t6"],
  attempts: ["tree-a1", "tree-a2", "tree-a3"],
  conversations: ["tree-c1", "tree-c2", "tree-c3"],
  pushes: ["tree-p1", "tree-p2"],
} as const;

const [T1, T2, T3, T4, T5, T6] = TREE_IDS.tasks;
const [A1, A2, A3] = TREE_IDS.attempts;
const [C1, C2, C3] = TREE_IDS.conversations;
const [P1, P2] = TREE_IDS.pushes;
const MODEL = FALLBACK_MODEL.replace(/'/g, "''");

const task = (id: string, rank: string) =>
  `INSERT INTO tasks (id, title, title_auto, rank) VALUES ('${id}', '${id} title', false, '${rank}')`;
const edge = (from: string, to: string) =>
  `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ('${from}', '${to}')`;
const attempt = (id: string, taskId: string) =>
  `INSERT INTO attempts (id, task_id, worktree_path) VALUES ('${id}', '${taskId}', '/tmp/${id}')`;
const conversation = (id: string, attemptId: string, status: string) =>
  `INSERT INTO conversations (id, attempt_id, title, status, model${status === "done" ? ", ended_at" : ""})
   VALUES ('${id}', '${attemptId}', '${id} title', '${status}', '${MODEL}'${status === "done" ? ", now()" : ""})`;
const push = (id: string, attemptId: string, conversationId: string) =>
  `INSERT INTO pushes (id, sha, message, push_id, attempt_id, conversation_id)
   VALUES ('${id}', '${id}-sha', '${id} message', '${id}-push', '${attemptId}', '${conversationId}')`;

/** The seed: five tasks, three edges, two attempts, two conversations, a push. */
export function treeSeed(): TreeStep[] {
  return [
    {
      label: "seed.tasks",
      statements: [
        task(T1, "a1"),
        task(T2, "a2"),
        task(T3, "a3"),
        task(T4, "a4"),
        task(T5, "a5"),
      ],
    },
    {
      label: "seed.edges",
      statements: [edge(T2, T1), edge(T3, T2), edge(T4, T1)],
    },
    { label: "seed.attempts", statements: [attempt(A1, T1), attempt(A2, T2)] },
    {
      label: "seed.conversations",
      statements: [
        conversation(C1, A1, "working"),
        conversation(C2, A2, "done"),
      ],
    },
    { label: "seed.pushes", statements: [push(P1, A1, C1)] },
  ];
}

/**
 * The scripted tree writes, in order: every kind of write the app makes to
 * the tree — an insert, a rename, a status flip, an edge added and removed, a
 * drag reorder, an attempt, a conversation and a push landing, a poller write,
 * an attempt moved between tasks, cascade deletes of an attempt and a task, a
 * drop.
 */
export function treeSteps(): TreeStep[] {
  return [
    { label: "task.insert", statements: [task(T6, "a6")] },
    { label: "edge.insert", statements: [edge(T6, T3)] },
    {
      label: "task.rename",
      statements: [
        `UPDATE tasks SET title = '${T2} renamed' WHERE id = '${T2}'`,
      ],
    },
    {
      label: "task.hold",
      statements: [`UPDATE tasks SET held_at = now() WHERE id = '${T3}'`],
    },
    { label: "attempt.insert", statements: [attempt(A3, T3)] },
    {
      label: "conversation.insert",
      statements: [conversation(C3, A3, "waiting")],
    },
    {
      label: "conversation.done",
      statements: [
        `UPDATE conversations SET status = 'done', ended_at = now() WHERE id = '${C1}'`,
      ],
    },
    {
      label: "conversation.poller",
      statements: [
        `UPDATE conversations SET waiting_for = 'permission', last_viewed_at = now() WHERE id = '${C3}'`,
      ],
    },
    { label: "push.insert", statements: [push(P2, A3, C3)] },
    {
      label: "task.reorder",
      statements: [`UPDATE tasks SET rank = 'a0' WHERE id = '${T5}'`],
    },
    {
      label: "attempt.move",
      statements: [`UPDATE attempts SET task_id = '${T4}' WHERE id = '${A2}'`],
    },
    {
      label: "edge.delete",
      statements: [
        `DELETE FROM task_dependencies WHERE task_id = '${T3}' AND depends_on_task_id = '${T2}'`,
      ],
    },
    {
      label: "attempt.delete",
      statements: [`DELETE FROM attempts WHERE id = '${A1}'`],
    },
    {
      label: "task.delete",
      statements: [`DELETE FROM tasks WHERE id = '${T2}'`],
    },
    {
      label: "task.drop",
      statements: [`UPDATE tasks SET dropped_at = now() WHERE id = '${T4}'`],
    },
  ];
}

/**
 * The script with a suite's own steps spliced in: each `after[label]` runs
 * right after the step of that label (an unknown label throws, so a renamed
 * step cannot silently drop a suite's case).
 */
export function withSteps(
  base: readonly TreeStep[],
  after: Readonly<Record<string, readonly TreeStep[]>>,
): TreeStep[] {
  const labels = new Set(base.map((s) => s.label));
  for (const label of Object.keys(after)) {
    if (!labels.has(label)) {
      throw new Error(`withSteps: no tree step "${label}" to run after`);
    }
  }
  return base.flatMap((s) => [s, ...(after[s.label] ?? [])]);
}
