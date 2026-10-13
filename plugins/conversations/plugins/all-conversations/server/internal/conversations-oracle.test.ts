/**
 * Differential oracle for the two conversation-list collections
 * (`conversations.all`, `conversations.history` — P7 of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md) on a throwaway
 * database seeded with the real migration chain, through the REAL feed: the
 * real declarations compiled exactly as `collection.ts` serves them (the owner
 * joins attempt → task, the All list's `unless: "kind"` default), registered on
 * a resource runtime of the suite's own, the change-feed's routed triggers
 * installed from the routes they registered (the first routed layouts on
 * `conversations`, `attempts` and `tasks`), its LISTEN consumer, and the
 * feed's own routing (`createChangeRouter`).
 *
 * The tuples are the ones the surfaces subscribe: the All pane's default
 * segment, its Kind = System filter (the default dropped), a search over the
 * task title (the task relation as membership), an updatedAt sort, History's
 * default segment and a title sort, and a point read.
 *
 * A seeded random workload of what the app writes — a conversation inserted,
 * its status / title / activity rewritten, a poller write (`waiting_for`,
 * `last_viewed_at`), a conversation deleted, a task renamed, an attempt's
 * checkout changed, an attempt moved between tasks, a task deleted (its
 * attempts and conversations cascading) — runs one statement at a time. After
 * every statement:
 *
 * - every subscribed tuple's client view equals a fresh FULL load of it;
 * - no tuple is reloaded FULL;
 * - every refill names only conversations the statement changed (directly, or
 *   through their attempt / task), or one a tuple now holds that one of them
 *   made room for;
 * - a poller write loads nothing at all.
 *
 * Then the named cases: a system conversation's status flip reaches History and
 * not All's default; C1 (an identity statement over the NOTIFY cap recomputes
 * FULL and converges); C2 (a rename of a task with more conversations than the
 * reverse cap recomputes the membership reader FULL and converges); C3 (a
 * 150-row `tasks` UPDATE keeps its ids — no `column` on a pk reverse halves
 * nothing — and loads no FULL).
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/conversations/plugins/all-conversations`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
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
  type ResourceParams,
} from "@plugins/framework/plugins/resource-runtime/core";
import {
  makeClientView,
  type ClientView,
  type RecordedFrame,
} from "@plugins/framework/plugins/resource-runtime/core/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { clause } from "@plugins/network/plugins/live/plugins/filter/core";
import type { LiveWhere } from "@plugins/network/plugins/live/core";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import {
  _attempts,
  _conversations,
  _tasks,
  conversationOwnerColumns,
  conversationOwnerJoins,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  allConversations,
  CONVERSATION_SEARCHABLE,
  conversationHistory,
} from "../../core";
import { allConversationsDefaults } from "./defaults";

interface Load {
  key: string;
  params: string;
  ids: readonly string[] | "FULL";
}

let testDb: TestDb;
let listener: ReturnType<typeof createChangeFeedListener>;
const routed: FeedChange[] = [];
const loads: Load[] = [];
const frames: RecordedFrame[] = [];
let seq = 0;

/** The unwrapped loaders, for the oracle's fresh FULL loads. */
const truth = new Map<
  string,
  (params: ResourceParams) => Promise<unknown> | unknown
>();

// The suite's OWN runtime, never server-core's process-global one:
// `./singularity test` runs every bun suite in one process, and any suite that
// loads `all-conversations/server` registers the real collections on the
// global registry at module eval — so registering them there too throws
// `defineResource: duplicate key`, whichever suite loads second (the
// events-core source-runs oracle does the same, for the same reason).
const runtime = createResourceRuntime();
const routeChange = createChangeRouter(runtime);

const handler = runtime.notificationsWsHandler as unknown as {
  open(ws: unknown): void;
  message(ws: unknown, raw: string): void;
  close(ws: unknown, code: number, reason: string): void;
};
const ws = {
  send(raw: string) {
    const frame = JSON.parse(raw) as Omit<RecordedFrame, "seq" | "socket">;
    if (frame.kind !== "ping") frames.push({ ...frame, seq: seq++, socket: 0 });
  },
};

/** Wait until no loader has run and no frame arrived for a while. */
async function quiet(): Promise<void> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const at = [loads.length, frames.length];
    await new Promise((r) => setTimeout(r, 150));
    if (loads.length === at[0] && frames.length === at[1]) return;
    if (Date.now() > deadline) throw new Error("the runtime never went quiet");
  }
}

/** Wait (bounded) for a condition the async runtime makes true. */
async function until(cond: () => boolean, what: () => string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what()}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * The compiled server options of the three resources this suite registers,
 * kept for the A17 check: the conversation lists' OWN routes, read off a
 * runtime holding nothing else. (The process-global registry also holds every
 * entry the tasks-core server barrel registers at import — the tree's sets,
 * whose rollup and children routes carry `attempt_id` on `conversations` —
 * so its union is not this suite's to assert.)
 */
const registeredHere: { descriptor: unknown; opts: unknown }[] = [];

const tupleKey = (key: string, params: ResourceParams) =>
  `${key} ${JSON.stringify(params)}`;

beforeAll(async () => {
  testDb = await createTestDb({ prefix: "conv_lists_oracle" });
  await runMigrations(testDb.db);
  const db = testDb.db as unknown as QueryDb;
  // Both collections, compiled from the REAL declarations with the options
  // `collection.ts` serves them with, against this database — registered on
  // the suite's runtime `routeChange` feeds, every loader run recorded.
  // (No custom-column sets: none are contributed here.)
  const record =
    <P extends ResourceParams, R>(
      key: string,
      loader: (p: P, ctx?: { affectedIds: readonly string[] }) => R,
    ) =>
    (p: P, ctx?: { affectedIds: readonly string[] }): R => {
      loads.push({
        key,
        params: JSON.stringify(p),
        ids: ctx ? [...ctx.affectedIds] : "FULL",
      });
      return loader(p, ctx);
    };
  const all = compileCollection(allConversations, {
    from: _conversations,
    joins: conversationOwnerJoins,
    columns: conversationOwnerColumns,
    defaults: allConversationsDefaults,
    db,
  });
  const history = compileCollection(conversationHistory, {
    from: _conversations,
    joins: conversationOwnerJoins,
    columns: conversationOwnerColumns,
    db,
  });
  for (const [collection, specs] of [
    [allConversations, all],
    [conversationHistory, history],
  ] as const) {
    const windowOpts = compileWindowQuery(
      collection.window,
      specs.window,
    ).serverOpts;
    runtime.defineResource(collection.window, {
      ...windowOpts,
      loader: record(collection.key, windowOpts.loader),
    });
    registeredHere.push({ descriptor: collection.window, opts: windowOpts });
    truth.set(collection.key, (p) => windowOpts.loader(p as never));
  }
  const rowsOpts = compileWindowQuery(
    allConversations.rows,
    all.rows,
  ).serverOpts;
  runtime.defineResource(allConversations.rows, {
    ...rowsOpts,
    loader: record(allConversations.rows.key, rowsOpts.loader),
  });
  registeredHere.push({ descriptor: allConversations.rows, opts: rowsOpts });
  truth.set(allConversations.rows.key, (p) => rowsOpts.loader(p as never));

  // The feed, installed from the routes just registered.
  await rebuildTriggers(
    testDb.db,
    { feedExempt: new Set(), optedOut: new Set(), produced: new Set() },
    runtime.routedTableRequirements(),
  );
  listener = createChangeFeedListener({
    connectionString: () => testDb.connectionString,
    route: (change) => {
      routed.push(change);
      routeChange(change);
    },
    coveredTables: () => ["conversations", "attempts", "tasks"],
    livenessIntervalMs: 60_000,
  });
  listener.start();
  const deadline = Date.now() + 8000;
  for (;;) {
    const res = await testDb.db.execute(
      sql`SELECT 1 FROM pg_stat_activity
          WHERE datname = current_database()
            AND query LIKE 'LISTEN live_state%'
            AND pid <> pg_backend_pid()`,
    );
    if (res.rows.length > 0) break;
    if (Date.now() > deadline) throw new Error("timed out waiting for LISTEN");
    await new Promise((r) => setTimeout(r, 20));
  }
  handler.open(ws);
}, 60_000);

afterAll(async () => {
  handler.close(ws, 1000, "test");
  await listener?.stop();
  await testDb?.drop();
});

// ── Views ───────────────────────────────────────────────────────────────────

const views = new Map<string, { view: ClientView; from: number }>();

/**
 * A row's fields compare as a set: a fresh load folds `$columns` after the
 * server-minted `$key`, a client view applies them in frame order.
 */
function sortedKeys(row: unknown): unknown {
  return row !== null && typeof row === "object" && !Array.isArray(row)
    ? Object.fromEntries(
        Object.entries(row).sort(([a], [b]) => (a < b ? -1 : 1)),
      )
    : row;
}

/** A point set is unordered (an entrant appends), so it compares by id. */
function comparable(key: string, value: unknown): string {
  if (!Array.isArray(value)) return JSON.stringify(value);
  const rows = value.map(sortedKeys) as { id: string }[];
  if (key !== allConversations.rows.key) return JSON.stringify(rows);
  return JSON.stringify(rows.sort((a, b) => (a.id < b.id ? -1 : 1)));
}

function viewOf(key: string, params: ResourceParams): ClientView {
  const entry = views.get(tupleKey(key, params))!;
  entry.view.applyAll(
    frames
      .slice(entry.from)
      .filter(
        (f) =>
          f.key === key &&
          JSON.stringify(f.params ?? {}) === JSON.stringify(params),
      ),
  );
  entry.from = frames.length;
  return entry.view;
}

async function subscribe(key: string, params: ResourceParams): Promise<void> {
  const from = frames.length;
  views.set(tupleKey(key, params), { view: makeClientView(), from });
  handler.message(ws, JSON.stringify({ op: "sub", key, params }));
  await until(
    () =>
      frames
        .slice(from)
        .some(
          (f) =>
            f.kind === "sub-ack" &&
            f.key === key &&
            JSON.stringify(f.params ?? {}) === JSON.stringify(params),
        ),
    () => `sub-ack ${key}`,
  );
}

function unsubscribe(key: string, params: ResourceParams): void {
  handler.message(ws, JSON.stringify({ op: "unsub", key, params }));
  views.delete(tupleKey(key, params));
}

type Tuple = { key: string; params: ResourceParams };

/** Every listed view equals a fresh FULL load of its tuple. */
async function converge(
  tuples: readonly Tuple[],
  what: string,
): Promise<Map<number, unknown>> {
  const expected = new Map<number, unknown>();
  for (const [i, t] of tuples.entries()) {
    expected.set(i, await truth.get(t.key)!(t.params));
  }
  const off = () =>
    [...tuples.entries()].find(
      ([i, t]) =>
        comparable(t.key, viewOf(t.key, t.params).value) !==
        comparable(t.key, expected.get(i)),
    );
  await until(
    () => off() === undefined,
    () => {
      const [i, t] = off()!;
      return `${what}: tuple ${JSON.stringify(t)} holds ${JSON.stringify(
        viewOf(t.key, t.params).value,
      )}, a fresh load reads ${JSON.stringify(expected.get(i))}`;
    },
  );
  await quiet();
  expect(off()).toBeUndefined();
  return expected;
}

// ── Seeding ─────────────────────────────────────────────────────────────────

const T0 = Date.parse("2026-10-01T00:00:00.000Z");
let clock = 0;
const tick = () => new Date(T0 + ++clock * 60_000);

async function insertTask(id: string, title: string): Promise<void> {
  await testDb.db.insert(_tasks).values({
    id,
    title,
    titleAuto: false,
    rank: `r${id}`,
  } as typeof _tasks.$inferInsert);
}

async function insertAttempt(
  id: string,
  taskId: string,
  worktreePath: string,
): Promise<void> {
  await testDb.db
    .insert(_attempts)
    .values({ id, taskId, worktreePath } as typeof _attempts.$inferInsert);
}

const STATUSES = ["starting", "working", "waiting", "gone", "done"] as const;
const KINDS = ["user", "agent", "system"] as const;

async function insertConversation(
  id: string,
  attemptId: string,
  opts: {
    kind: (typeof KINDS)[number];
    status: (typeof STATUSES)[number];
    title: string | null;
  },
): Promise<void> {
  const at = tick();
  await testDb.db.insert(_conversations).values({
    id,
    attemptId,
    title: opts.title,
    status: opts.status,
    runtime: "tmux",
    model: FALLBACK_MODEL,
    kind: opts.kind,
    createdAt: at,
    updatedAt: at,
    endedAt: opts.status === "done" ? at : null,
  } as typeof _conversations.$inferInsert);
}

/**
 * A task `<tag>-task` with one attempt `<tag>-att` owning 520 conversations —
 * over both the reverse cap and, with ids this long, the 7000-byte NOTIFY cap.
 */
async function seedOverCap(tag: string): Promise<void> {
  await insertTask(`${tag}-task`, `${tag} big`);
  await insertAttempt(`${tag}-att`, `${tag}-task`, `/wt/${tag}`);
  await testDb.db.execute(
    sql.raw(
      `INSERT INTO conversations (id, attempt_id, title, status, runtime, model, kind, created_at, updated_at)
         SELECT '${tag}-conversation-' || g, '${tag}-att', '${tag} ' || g, 'working', 'tmux', '${FALLBACK_MODEL}', 'user',
                now() + (g || ' seconds')::interval, now()
           FROM generate_series(1, 520) g`,
    ),
  );
  await quiet();
}

// ── Tuples ──────────────────────────────────────────────────────────────────

const aw = allConversations.window.window;
const hw = conversationHistory.window.window;
/** The DataView's search box lowered: an OR of `contains` over the searchable columns. */
const search = (q: string): LiveWhere<typeof allConversations.filterable> => ({
  or: CONVERSATION_SEARCHABLE.map((column) => clause(column, "contains", q)),
});

const TUPLES: Tuple[] = [
  // The All pane's first page (system hidden by the default).
  { key: allConversations.key, params: aw.encode({ limit: 4 }) },
  // Kind = System: the default dropped.
  {
    key: allConversations.key,
    params: aw.encode({ where: { kind: { eq: "system" } }, limit: 3 }),
  },
  // A search reaching the task title: the task relation is membership.
  {
    key: allConversations.key,
    params: aw.encode({ where: search("alpha"), limit: 4 }),
  },
  // Live activity, by last activity.
  {
    key: allConversations.key,
    params: aw.encode({
      where: { status: { in: ["working", "waiting"] } },
      orderBy: [["updatedAt", "desc"]],
      limit: 3,
    }),
  },
  // History's first page (system included).
  { key: conversationHistory.key, params: hw.encode({ limit: 5 }) },
  // History by title.
  {
    key: conversationHistory.key,
    params: hw.encode({ orderBy: [["title", "asc"]], limit: 3 }),
  },
  // A by-id read.
  {
    key: allConversations.rows.key,
    params: allConversations.rows.point.encode(["c0", "c1", "c2", "c3", "c4"]),
  },
];

// ── The workload ────────────────────────────────────────────────────────────

/** A small deterministic PRNG (mulberry32), so a failing run replays. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("conversation lists — scoped differential oracle", () => {
  test("the collections route conversations, attempts and tasks; pk reverses carry no key (A17)", () => {
    const local = createResourceRuntime();
    for (const { descriptor, opts } of registeredHere) {
      local.defineResource(
        descriptor as Parameters<typeof local.defineResource>[0],
        opts as Parameters<typeof local.defineResource>[1],
      );
    }
    const required = new Map(
      local.routedTableRequirements().map((r) => [r.table, r.carry]),
    );
    expect(required.get("conversations")).toEqual([]);
    expect(required.get("attempts")).toEqual([]);
    expect(required.get("tasks")).toEqual([]);
  });

  test("random conversation / attempt / task writes: every view converges, refills stay O(changed), poller writes load nothing", async () => {
    const rand = prng(1313);
    const any = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
    // The model the refill bounds are computed from.
    const taskOf = new Map<string, string>(); // attempt → task
    const attemptOf = new Map<string, string>(); // conversation → attempt
    const tasks = new Set<string>();
    let nextTask = 0;
    let nextAttempt = 0;
    let nextConv = 0;
    const TITLES = ["alpha one", "beta", "gamma alpha", "delta"];

    const newTask = async (): Promise<string> => {
      const id = `t${nextTask++}`;
      await insertTask(id, any(TITLES));
      tasks.add(id);
      return id;
    };
    const newAttempt = async (taskId: string): Promise<string> => {
      const id = `a${nextAttempt++}`;
      await insertAttempt(id, taskId, `/wt/${id}`);
      taskOf.set(id, taskId);
      return id;
    };
    const newConversation = async (): Promise<string> => {
      const id = `c${nextConv++}`;
      const attemptId = any([...taskOf.keys()]);
      await insertConversation(id, attemptId, {
        kind: any(KINDS),
        status: any(STATUSES),
        title: rand() < 0.15 ? null : `conv ${any(["x", "y", "alpha", "z"])}`,
      });
      attemptOf.set(id, attemptId);
      return id;
    };
    const convsOfAttempts = (attempts: ReadonlySet<string>) =>
      [...attemptOf].filter(([, a]) => attempts.has(a)).map(([c]) => c);
    const attemptsOfTask = (taskId: string) =>
      new Set([...taskOf].filter(([, t]) => t === taskId).map(([a]) => a));

    for (let i = 0; i < 4; i++) await newTask();
    for (const t of [...tasks]) await newAttempt(t);
    await newAttempt(any([...tasks]));
    for (let i = 0; i < 12; i++) await newConversation();
    await quiet();
    for (const t of TUPLES) await subscribe(t.key, t.params);
    await converge(TUPLES, "subscribed");

    const history: string[] = [];
    let pollerRounds = 0;
    for (let round = 0; round < 60; round++) {
      const loadsAt = loads.length;
      const routedAt = routed.length;
      const changed = new Set<string>();
      let inert = false;
      let what: string;
      const r = rand();
      const convs = [...attemptOf.keys()];
      if (r < 0.2 || convs.length < 4) {
        const id = await newConversation();
        what = `insert ${id}`;
        changed.add(id);
      } else if (r < 0.35) {
        const id = any(convs);
        const status = any(STATUSES);
        what = `status ${id} → ${status}`;
        const at = tick();
        await testDb.db
          .update(_conversations)
          .set({
            status,
            updatedAt: at,
            endedAt: status === "done" ? at : null,
          })
          .where(eq(_conversations.id, id));
        changed.add(id);
      } else if (r < 0.43) {
        const id = any(convs);
        what = `retitle ${id}`;
        await testDb.db
          .update(_conversations)
          .set({ title: `conv ${any(["x", "alpha", "q"])} ${round}` })
          .where(eq(_conversations.id, id));
        changed.add(id);
      } else if (r < 0.53) {
        const id = any(convs);
        what = `poller ${id}`;
        inert = true;
        await testDb.db
          .update(_conversations)
          .set({
            waitingFor: rand() < 0.5 ? "permission" : null,
            lastViewedAt: tick(),
          })
          .where(eq(_conversations.id, id));
      } else if (r < 0.6) {
        const id = any(convs);
        what = `delete ${id}`;
        await testDb.db.delete(_conversations).where(eq(_conversations.id, id));
        attemptOf.delete(id);
        changed.add(id);
      } else if (r < 0.72) {
        const taskId = any([...tasks]);
        const title = `${any(TITLES)} ${round}`;
        what = `rename ${taskId} → ${title}`;
        await testDb.db
          .update(_tasks)
          .set({ title })
          .where(eq(_tasks.id, taskId));
        for (const c of convsOfAttempts(attemptsOfTask(taskId))) changed.add(c);
      } else if (r < 0.8) {
        const attemptId = any([...taskOf.keys()]);
        what = `worktree ${attemptId}`;
        await testDb.db
          .update(_attempts)
          .set({ worktreePath: `/wt/${attemptId}-${round}` })
          .where(eq(_attempts.id, attemptId));
        for (const c of convsOfAttempts(new Set([attemptId]))) changed.add(c);
      } else if (r < 0.9) {
        const attemptId = any([...taskOf.keys()]);
        const to = any([...tasks]);
        what = `move ${attemptId} → ${to}`;
        await testDb.db
          .update(_attempts)
          .set({ taskId: to })
          .where(eq(_attempts.id, attemptId));
        taskOf.set(attemptId, to);
        for (const c of convsOfAttempts(new Set([attemptId]))) changed.add(c);
      } else if (tasks.size > 2) {
        // A task deleted: its attempts and conversations cascade away; a new
        // task with an attempt takes its place.
        const taskId = any([...tasks]);
        const attempts = attemptsOfTask(taskId);
        const cascaded = convsOfAttempts(attempts);
        what = `delete task ${taskId} (${cascaded.length} conversations)`;
        await testDb.db.delete(_tasks).where(eq(_tasks.id, taskId));
        tasks.delete(taskId);
        for (const a of attempts) taskOf.delete(a);
        for (const c of cascaded) {
          attemptOf.delete(c);
          changed.add(c);
        }
        await newAttempt(await newTask());
      } else {
        what = "noop";
        inert = true;
      }
      history.push(what);

      if (inert) {
        if (what.startsWith("poller")) {
          pollerRounds++;
          // The statement committed and was routed (the feed sees the table)…
          await until(
            () =>
              routed.slice(routedAt).some((c) => c.table === "conversations"),
            () => `round ${round} (${what}): never routed`,
          );
        }
        await quiet();
        // …and reached no tuple.
        expect(loads.slice(loadsAt)).toEqual([]);
        continue;
      }

      const expected = await converge(TUPLES, `round ${round} (${what})`);
      const roundLoads = loads.slice(loadsAt);
      const holds = (load: Load, id: string) =>
        TUPLES.some(
          (t, i) =>
            t.key === load.key &&
            JSON.stringify(t.params) === load.params &&
            Array.isArray(expected.get(i)) &&
            (expected.get(i) as { id?: string }[]).some((row) => row.id === id),
        );
      for (const load of roundLoads) {
        if (load.ids === "FULL") {
          throw new Error(
            `round ${round} (${what}) loaded ${load.key} ${load.params} FULL — ` +
              `this round's loads: ${JSON.stringify(roundLoads)}; history: ${history.slice(-4).join(" | ")}`,
          );
        }
        const stray = load.ids.filter(
          (id) => !changed.has(id) && !holds(load, id),
        );
        if (stray.length > 0) {
          throw new Error(
            `round ${round} (${what}; changed ${[...changed].join(",")}) refilled ${JSON.stringify(load.ids)} ` +
              `for ${load.key} ${load.params} — this round's loads: ${JSON.stringify(roundLoads)}; ` +
              `history: ${history.slice(-4).join(" | ")}`,
          );
        }
      }
    }
    expect(pollerRounds).toBeGreaterThan(0);
    for (const kind of ["rename", "move", "worktree", "delete task"]) {
      expect(history.some((h) => h.startsWith(kind))).toBe(true);
    }
    for (const t of TUPLES) unsubscribe(t.key, t.params);
    await quiet();
  }, 300_000);

  test("a system conversation's status flip reaches History, not All's default", async () => {
    await insertTask("sys-task", "system work");
    await insertAttempt("sys-att", "sys-task", "/wt/sys");
    await insertConversation("sys-conv", "sys-att", {
      kind: "system",
      status: "working",
      title: "a system conversation",
    });
    await quiet();
    const allDefault = { key: allConversations.key, params: aw.encode() };
    const hist = { key: conversationHistory.key, params: hw.encode() };
    await subscribe(allDefault.key, allDefault.params);
    await subscribe(hist.key, hist.params);
    const before = await converge([allDefault, hist], "subscribed");
    expect(
      (before.get(1) as { id: string }[]).some((r) => r.id === "sys-conv"),
    ).toBe(true);
    expect(
      (before.get(0) as { id: string }[]).some((r) => r.id === "sys-conv"),
    ).toBe(false);

    const at = loads.length;
    await testDb.db
      .update(_conversations)
      .set({ status: "waiting" })
      .where(eq(_conversations.id, "sys-conv"));
    await until(
      () => loads.slice(at).some((l) => l.key === hist.key),
      () => "the flip reached History",
    );
    const after = await converge([allDefault, hist], "system flip");
    expect(
      (after.get(1) as { id: string; status: string }[]).find(
        (r) => r.id === "sys-conv",
      )!.status,
    ).toBe("waiting");
    expect(loads.slice(at).filter((l) => l.key === allDefault.key)).toEqual([]);
    unsubscribe(allDefault.key, allDefault.params);
    unsubscribe(hist.key, hist.params);
    await quiet();
  }, 60_000);

  test("C3: a 150-row tasks UPDATE keeps its ids and loads nothing FULL", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `c3-task-${i}`);
    for (const id of ids) await insertTask(id, `c3 ${id}`);
    await insertAttempt("c3-att", ids[0]!, "/wt/c3");
    await insertConversation("c3-conv", "c3-att", {
      kind: "user",
      status: "working",
      title: "c3",
    });
    await quiet();
    const tuple = { key: allConversations.key, params: aw.encode() };
    await subscribe(tuple.key, tuple.params);
    await converge([tuple], "subscribed");

    const routedAt = routed.length;
    const at = loads.length;
    await testDb.db
      .update(_tasks)
      .set({ title: sql`${_tasks.title} || ' (renamed)'` })
      .where(inArray(_tasks.id, ids));
    await until(
      () => routed.slice(routedAt).some((c) => c.table === "tasks"),
      () => "the bulk rename was routed",
    );
    const change = routed.slice(routedAt).find((c) => c.table === "tasks")!;
    expect(change.ids).not.toBeNull();
    expect([...change.ids!].sort()).toEqual([...ids].sort());
    await converge([tuple], "bulk rename");
    expect(
      loads.slice(at).filter((l) => l.key === tuple.key && l.ids === "FULL"),
    ).toEqual([]);
    const row = (
      (await truth.get(tuple.key)!(tuple.params)) as {
        id: string;
        taskTitle: string;
      }[]
    ).find((r) => r.id === "c3-conv")!;
    expect(row.taskTitle).toBe(`c3 ${ids[0]} (renamed)`);
    unsubscribe(tuple.key, tuple.params);
    await quiet();
  }, 60_000);

  test("C2: renaming a task with more conversations than the reverse cap recomputes its membership reader FULL, and converges", async () => {
    await seedOverCap("c2");
    const searching = {
      key: allConversations.key,
      params: aw.encode({ where: search("needle"), limit: 10 }),
    };
    const plain = { key: allConversations.key, params: aw.encode() };
    await subscribe(searching.key, searching.params);
    await subscribe(plain.key, plain.params);
    await converge([searching, plain], "subscribed");

    const at = loads.length;
    await testDb.db
      .update(_tasks)
      .set({ title: "c2 needle" })
      .where(eq(_tasks.id, "c2-task"));
    await until(
      () => loads.slice(at).some((l) => l.key === searching.key),
      () => "the over-cap rename reached the searching window",
    );
    const after = await converge([searching, plain], "over-cap rename");
    expect((after.get(0) as unknown[]).length).toBe(10);
    // The membership reader resolved unbounded: over the cap, FULL.
    expect(
      loads
        .slice(at)
        .some(
          (l) =>
            l.params === JSON.stringify(searching.params) && l.ids === "FULL",
        ),
    ).toBe(true);
    // The value reader resolved within its members: scoped.
    expect(
      loads
        .slice(at)
        .some(
          (l) => l.params === JSON.stringify(plain.params) && l.ids === "FULL",
        ),
    ).toBe(false);
    unsubscribe(searching.key, searching.params);
    unsubscribe(plain.key, plain.params);
    await quiet();
  }, 60_000);

  test("C1: a conversations statement over the NOTIFY cap drops its ids, recomputes FULL, and converges", async () => {
    await seedOverCap("c1");
    const tuple = { key: conversationHistory.key, params: hw.encode() };
    await subscribe(tuple.key, tuple.params);
    await converge([tuple], "subscribed");
    const routedAt = routed.length;
    const at = loads.length;
    await testDb.db
      .update(_conversations)
      .set({ title: sql`coalesce(${_conversations.title}, '') || ' !'` })
      .where(eq(_conversations.attemptId, "c1-att"));
    await until(
      () => routed.slice(routedAt).some((c) => c.table === "conversations"),
      () => "the bulk update was routed",
    );
    const change = routed
      .slice(routedAt)
      .find((c) => c.table === "conversations")!;
    // 520 ids of ~20 bytes are well over the 7000-byte NOTIFY cap: the feed
    // says only "something changed".
    expect(change.ids).toBeNull();
    await converge([tuple], "over-cap identity");
    // No ids to scope by: the tuple was recomputed FULL.
    expect(
      loads
        .slice(at)
        .some(
          (l) =>
            l.key === tuple.key &&
            l.params === JSON.stringify(tuple.params) &&
            l.ids === "FULL",
        ),
    ).toBe(true);
    unsubscribe(tuple.key, tuple.params);
    await quiet();
  }, 60_000);
});
