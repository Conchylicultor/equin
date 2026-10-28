/**
 * The task tree is LIVE end to end (P8 v3, steps 18–22; v2 *Verification* →
 * `tree-live-verify`): rows written straight into the deploy's database reach
 * an open Tasks pane over the socket, as scoped deltas, with no HTTP read of
 * the tree's live resources after first paint and no page reload — and a
 * reload's first paint is already current (the boot snapshot).
 *
 * Each conversion step adds its phase here. Landed:
 *
 *  - **18 `task-categories`** — a category set on a seeded task arrives as one
 *    upsert, a change as one upsert, a clear as one delete (checked on the
 *    socket's frames, not in the DOM). A reload's boot snapshot carries the
 *    current set.
 *
 *  - **19 `tasks`** — a second seeded task arrives as an entrant (one upsert),
 *    a hold and a release of the first each as one upsert of its row with the
 *    new status, an edge making the second run after the first as one upsert
 *    of the second (`dependencies`, `blocked`), the edge's removal likewise,
 *    and the second task's delete as one delete. A reload's boot snapshot
 *    carries the first task.
 *
 *  - **20 `attempts`** — an attempt on the seeded task arrives as an entrant
 *    (`pending`, no conversations) and moves the task to `in_progress` (an
 *    attempt with no conversation yet is `active`: its agent is expected); a
 *    conversation of it as one upsert of the attempt (`closed`, the
 *    conversation listed); a retitle as one upsert carrying the new title; a
 *    push as one upsert of the
 *    attempt (`completed`) and of the task (`done`); the attempt's delete as a
 *    delete, and the task back to `new`. The page is the task's detail pane,
 *    whose attempt sections read the set.
 *
 *    What a write no field reads (the poller's `waiting_for` /
 *    `last_viewed_at`) costs is NOT checked here: the runtime diffs a refill
 *    against the kept rows and sends no frame for an identical row, so a
 *    wasted refill is invisible on the socket. The tree oracle pins it
 *    (`conversation.poller`: no load on `attempts`), counting loads.
 *
 *  - **21 `agent-launches`** — a launch of a seeded agent on the seeded task
 *    arrives as an entrant (no latest conversation); an attempt with a
 *    `working` conversation as one upsert of the launch carrying it; the
 *    conversation's close as one upsert (`done`); the attempt's delete (its
 *    conversation cascades) as one upsert back to no latest conversation —
 *    W8, which the boot reconcile alone used to heal; the launch's delete as
 *    a delete. The phase opens the seeded agent's detail pane on a page of
 *    its own, whose status dot and Attempts list read the set for as long as
 *    it is open.
 *
 *  - **22 the conversation lists** — W9: a page opened on a done
 *    conversation older than the newest 30 ended ones resolves it from the
 *    `conversations.by-id` read, with no REST call. A new conversation arrives
 *    as an entrant of `conversations-active`, a poller's `waiting_for` and a
 *    rename of its task (`taskTitle`) each as one upsert, its close as a
 *    delete from the active set and an entrant of the gone window, its delete
 *    as a delete from the window; no list or by-id read goes over HTTP.
 *    Then the by-id pane's boot cost is pinned: a reloaded active
 *    conversation's pane paints only after its by-id answer (lookup-only
 *    reads are never in the boot snapshot), with the latency reported.
 *
 * Seeds go straight into the deploy's database (out of band, so anything that
 * arrives came off the server), are reactor-inert (`title_auto = false`; the
 * attempt has a nonexistent worktree, its one conversation is `done`, and
 * nothing runs the code paths that emit `pushes.landed` or
 * `tasks.statusChanged`) and are deleted at the end (also on failure).
 * Refuses main.
 *
 * Manual only — nothing runs this automatically.
 *   ./equin run plugins/tasks/plugins/tasks-core/e2e/tree-live-verify.ts [--headed] [--out /tmp/tree-live]
 */
import { randomBytes } from "node:crypto";
import type { Page } from "playwright";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import {
  arg,
  boot,
  onBeforeFinish,
  openDeployDb,
  pathUrl,
  report,
  snap,
  waitFor,
  withBrowser,
  type Harness,
  type Report,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import { tapSharedSocket } from "@plugins/primitives/plugins/networking/e2e";

const OUT = arg("out") ?? "/tmp/tree-live";
/** Every seeded id starts with this, so a crashed run's leftovers are swept by prefix. */
const SEED_PREFIX = "e2e-tree-";
/** The live keys this script watches, and what an HTTP read of one looks like. */
const TREE_KEYS = ["task-categories", "tasks", "attempts"] as const;

const db = openDeployDb();

let cleaned = false;
async function cleanup(): Promise<void> {
  if (cleaned) return;
  cleaned = true;
  // Categories, attempts, their conversations and pushes cascade with the
  // task; launches with their agent (a launch's task is a soft link).
  await db.query("DELETE FROM tasks WHERE id LIKE $1", [`${SEED_PREFIX}%`]);
  await db.query("DELETE FROM agents WHERE id LIKE $1", [`${SEED_PREFIX}%`]);
  await db.close();
}
onBeforeFinish(cleanup);

interface Frame {
  kind?: string;
  key?: string;
  value?: unknown;
  upserts?: [string, unknown][];
  deletes?: string[];
}

/**
 * Every live frame the page receives, parsed, in order. Through the shared
 * socket's tap: the socket lives in a SharedWorker, out of `page.on("websocket")`'s
 * reach. Call before the page's first navigation.
 */
async function recordFrames(page: Page): Promise<Frame[]> {
  const frames: Frame[] = [];
  const tap = await tapSharedSocket(page);
  tap.onFrame((f) => {
    frames.push(JSON.parse(f.data) as Frame);
  });
  return frames;
}

/** HTTP reads of a tree key's live resource (a refetch, after first paint). */
function recordHttpReads(
  page: Page,
  keys: readonly string[] = TREE_KEYS,
): string[] {
  const reads: string[] = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (keys.some((k) => path.startsWith(`/api/resources/${k}`))) {
      reads.push(req.url());
    }
  });
  return reads;
}

const framesOf = (frames: Frame[], key: string, from: number) =>
  frames.slice(from).filter((f) => f.key === key);

/** The upsert of `id` some frame of `key` since `from` carries, if any. */
function upsertOf(frames: Frame[], key: string, id: string, from: number) {
  for (const f of framesOf(frames, key, from)) {
    const hit = f.upserts?.find(([k]) => k === id);
    if (hit) return hit[1];
  }
  return undefined;
}

const deleted = (frames: Frame[], key: string, id: string, from: number) =>
  framesOf(frames, key, from).some((f) => f.deletes?.includes(id));

/**
 * Step 18: `task-categories` — set, change, clear, each one scoped delta; and
 * over the whole phase (from `measureFrom`, the first frame after the page's
 * own subscribe, to the phase's last frame) no frame re-sent the whole set.
 */
async function categoriesPhase(
  r: Report,
  page: Page,
  frames: Frame[],
  taskId: string,
  measureFrom: number,
): Promise<void> {
  const KEY = "task-categories";
  let at = frames.length;
  await db.query(
    "INSERT INTO tasks_ext_category (parent_id, category) VALUES ($1, 'wishes')",
    [taskId],
  );
  const set = await waitFor(
    async () => upsertOf(frames, KEY, taskId, at),
    (row) => row !== undefined,
    { timeoutMs: 15_000 },
  );
  r.eq("a category set arrives as an upsert of the task's row", set.value, {
    taskId,
    category: "wishes",
  });
  await snap(page, OUT, "18-category-set");

  at = frames.length;
  await db.query(
    "UPDATE tasks_ext_category SET category = 'reports' WHERE parent_id = $1",
    [taskId],
  );
  const changed = await waitFor(
    async () => upsertOf(frames, KEY, taskId, at),
    (row) => row !== undefined,
    { timeoutMs: 15_000 },
  );
  r.eq("a category change arrives as one upsert", changed.value, {
    taskId,
    category: "reports",
  });

  at = frames.length;
  await db.query("DELETE FROM tasks_ext_category WHERE parent_id = $1", [
    taskId,
  ]);
  const cleared = await waitFor(
    async () => deleted(frames, KEY, taskId, at),
    (gone) => gone,
    { timeoutMs: 15_000 },
  );
  r.ok("a category clear arrives as a delete", cleared.ok);

  // Leave it categorized for the reload check — and wait for that upsert on
  // the socket, so the kept snapshot the reload's boot snapshot reads has it
  // (a reload racing the write would fail the check intermittently).
  at = frames.length;
  await db.query(
    "INSERT INTO tasks_ext_category (parent_id, category) VALUES ($1, 'agents')",
    [taskId],
  );
  const reset = await waitFor(
    async () => upsertOf(frames, KEY, taskId, at),
    (row) => row !== undefined,
    { timeoutMs: 15_000 },
  );
  r.eq("a category set after a clear arrives as an upsert", reset.value, {
    taskId,
    category: "agents",
  });

  // Checked once the phase is over, so a whole-set re-send arriving AFTER the
  // delta it trails is caught too — not only the frames up to each upsert.
  const phase = framesOf(frames, KEY, measureFrom);
  r.ok(
    "no frame re-sent the whole set, over the whole phase",
    phase.every((f) => f.value === undefined),
    phase
      .map((f) => `${f.kind ?? "?"}${f.value !== undefined ? "(value)" : ""}`)
      .join(", "),
  );
}

interface TaskRow {
  id?: string;
  status?: string;
  dependencies?: string[];
}

/**
 * Step 19: `tasks` — an entrant, a status flip each way, an edge added and
 * removed, a delete: each one scoped delta of the rows it moves, and over the
 * whole phase no frame re-sent the whole set.
 */
async function tasksPhase(
  r: Report,
  page: Page,
  frames: Frame[],
  taskId: string,
  measureFrom: number,
): Promise<void> {
  const KEY = "tasks";
  const otherId = `${taskId}-b`;
  const upsertWhere = async (
    id: string,
    at: number,
    ok: (row: TaskRow) => boolean,
  ) =>
    waitFor(
      async () => {
        for (const f of framesOf(frames, KEY, at)) {
          const hit = f.upserts?.find(([k]) => k === id);
          if (hit && ok(hit[1] as TaskRow)) return hit[1] as TaskRow;
        }
        return undefined;
      },
      (row) => row !== undefined,
      { timeoutMs: 15_000 },
    );

  let at = frames.length;
  await db.query(
    "INSERT INTO tasks (id, title, title_auto, rank, mandate) VALUES ($1, $2, false, $3, '{}')",
    [otherId, `${otherId} task`, `zz${otherId}`],
  );
  const entered = await upsertWhere(otherId, at, () => true);
  r.eq(
    "a new task arrives as an upsert of its row",
    entered.value?.status,
    "new",
  );

  at = frames.length;
  await db.query("UPDATE tasks SET held_at = now() WHERE id = $1", [taskId]);
  const held = await upsertWhere(taskId, at, (row) => row.status === "held");
  r.ok("a hold arrives as one upsert with status `held`", held.ok);
  await snap(page, OUT, "19-held");

  at = frames.length;
  await db.query("UPDATE tasks SET held_at = NULL WHERE id = $1", [taskId]);
  const released = await upsertWhere(taskId, at, (row) => row.status === "new");
  r.ok("a release arrives as one upsert with status `new`", released.ok);

  at = frames.length;
  await db.query(
    "INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)",
    [otherId, taskId],
  );
  const blocked = await upsertWhere(
    otherId,
    at,
    (row) => row.status === "blocked",
  );
  r.eq(
    "an edge arrives as one upsert of the task that now runs after it (`blocked`)",
    blocked.value?.dependencies,
    [taskId],
  );

  at = frames.length;
  await db.query(
    "DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2",
    [otherId, taskId],
  );
  const unblocked = await upsertWhere(
    otherId,
    at,
    (row) => row.status === "new",
  );
  r.eq(
    "the edge's removal arrives as one upsert (`new`, no dependencies)",
    unblocked.value?.dependencies,
    [],
  );

  at = frames.length;
  await db.query("DELETE FROM tasks WHERE id = $1", [otherId]);
  const gone = await waitFor(
    async () => deleted(frames, KEY, otherId, at),
    (d) => d,
    { timeoutMs: 15_000 },
  );
  r.ok("a task delete arrives as a delete", gone.ok);

  const phase = framesOf(frames, KEY, measureFrom);
  r.ok(
    "no `tasks` frame re-sent the whole set, over the whole phase",
    phase.every((f) => f.value === undefined),
    phase
      .map((f) => `${f.kind ?? "?"}${f.value !== undefined ? "(value)" : ""}`)
      .join(", "),
  );
}

interface AttemptRow {
  id?: string;
  status?: string;
  conversations?: { id: string; title: string | null; status: string }[];
}

/**
 * Step 20: `attempts` — an entrant, a conversation, a write no field reads, a
 * retitle, a push, a delete: each one scoped delta of the attempt it moves
 * (and of the task, where the attempt's status moves the task's), and over
 * the whole phase no frame re-sent the whole set.
 */
async function attemptsPhase(
  r: Report,
  page: Page,
  frames: Frame[],
  taskId: string,
  measureFrom: number,
): Promise<void> {
  const KEY = "attempts";
  const attemptId = `${taskId}-att`;
  const convId = `${taskId}-conv`;
  const upsertWhere = async <Row>(
    key: string,
    id: string,
    at: number,
    ok: (row: Row) => boolean,
  ) =>
    waitFor(
      async () => {
        for (const f of framesOf(frames, key, at)) {
          const hit = f.upserts?.find(([k]) => k === id);
          if (hit && ok(hit[1] as Row)) return hit[1] as Row;
        }
        return undefined;
      },
      (row) => row !== undefined,
      { timeoutMs: 15_000 },
    );

  let at = frames.length;
  await db.query(
    "INSERT INTO attempts (id, task_id, worktree_path) VALUES ($1, $2, $3)",
    [attemptId, taskId, `/tmp/${attemptId}`],
  );
  const entered = await upsertWhere<AttemptRow>(KEY, attemptId, at, () => true);
  r.eq(
    "a new attempt arrives as an upsert of its row (`pending`, no conversations)",
    [entered.value?.status, entered.value?.conversations],
    ["pending", []],
  );
  // A pending attempt is `active` (its agent is expected to run).
  const started = await upsertWhere<TaskRow>(
    "tasks",
    taskId,
    at,
    (row) => row.status === "in_progress",
  );
  r.ok("…and the task arrives as one upsert (`in_progress`)", started.ok);

  at = frames.length;
  await db.query(
    `INSERT INTO conversations (id, attempt_id, title, status, model, kind, ended_at)
     VALUES ($1, $2, $3, 'done', $4, 'user', now())`,
    [convId, attemptId, `${convId} run`, FALLBACK_MODEL],
  );
  const withConv = await upsertWhere<AttemptRow>(
    KEY,
    attemptId,
    at,
    (row) => row.conversations?.length === 1,
  );
  r.eq(
    "a conversation arrives as one upsert of its attempt (`closed`, listed)",
    [withConv.value?.status, withConv.value?.conversations?.[0]?.id],
    ["closed", convId],
  );
  await snap(page, OUT, "20-conversation");

  // A retitle: the conversation list reads `title`, so the first `attempts`
  // frame naming the attempt carries the new one. (A write no field reads
  // sends no frame even when it costs a refill — the runtime suppresses an
  // identical row — so its cost is the tree oracle's, not this script's.)
  at = frames.length;
  await db.query("UPDATE conversations SET title = $2 WHERE id = $1", [
    convId,
    `${convId} renamed`,
  ]);
  const renamed = await upsertWhere<AttemptRow>(
    KEY,
    attemptId,
    at,
    (row) => row.conversations?.[0]?.title === `${convId} renamed`,
  );
  const first = framesOf(frames, KEY, at).find((f) =>
    f.upserts?.some(([k]) => k === attemptId),
  );
  r.ok(
    "a retitle arrives as one upsert of its attempt, carrying the new title",
    renamed.ok &&
      (
        first?.upserts?.find(([k]) => k === attemptId)?.[1] as
          AttemptRow | undefined
      )?.conversations?.[0]?.title === `${convId} renamed`,
  );

  at = frames.length;
  await db.query(
    `INSERT INTO pushes (id, sha, message, push_id, attempt_id, conversation_id)
     VALUES ($1, $2, 'e2e', $3, $4, $5)`,
    [
      `${attemptId}-push`,
      `${attemptId}-sha`,
      `${attemptId}-pid`,
      attemptId,
      convId,
    ],
  );
  const completed = await upsertWhere<AttemptRow>(
    KEY,
    attemptId,
    at,
    (row) => row.status === "completed",
  );
  r.ok(
    "a push arrives as one upsert of its attempt (`completed`)",
    completed.ok,
  );
  const done = await upsertWhere<TaskRow>(
    "tasks",
    taskId,
    at,
    (row) => row.status === "done",
  );
  r.ok("…and of the task (`done`)", done.ok);

  at = frames.length;
  await db.query("DELETE FROM attempts WHERE id = $1", [attemptId]);
  const gone = await waitFor(
    async () => deleted(frames, KEY, attemptId, at),
    (d) => d,
    { timeoutMs: 15_000 },
  );
  r.ok("an attempt delete arrives as a delete", gone.ok);
  const fresh = await upsertWhere<TaskRow>(
    "tasks",
    taskId,
    at,
    (row) => row.status === "new",
  );
  r.ok("…and the task as one upsert (`new`)", fresh.ok);

  const phase = framesOf(frames, KEY, measureFrom);
  r.ok(
    "no `attempts` frame re-sent the whole set, over the whole phase",
    phase.every((f) => f.value === undefined),
    phase
      .map((f) => `${f.kind ?? "?"}${f.value !== undefined ? "(value)" : ""}`)
      .join(", "),
  );
}

interface LaunchRow {
  id?: string;
  latestConversationStatus?: string | null;
  latestConversation?: { id: string; status: string } | null;
}

/**
 * Step 21: `agent-launches` — an entrant, a conversation landing on its task,
 * the conversation's close, the attempt's delete (W8), the launch's delete:
 * each one scoped delta of the launch, and over the whole phase no frame
 * re-sent the whole set.
 */
async function launchesPhase(
  r: Report,
  h: Harness,
  taskId: string,
): Promise<void> {
  const KEY = "agent-launches";
  const agentId = `${taskId}-agent`;
  const agentName = `${agentId} agent`;
  const launchId = `${taskId}-launch`;
  const attemptId = `${taskId}-latt`;
  const convId = `${taskId}-lconv`;

  // The agent's detail pane: its status dot and Attempts list read the set
  // for as long as it is open (the task pane reads it only through the agent
  // avatar of a conversation item, which comes and goes with the item).
  await db.query(
    "INSERT INTO agents (id, name, prompt, rank) VALUES ($1, $2, 'e2e', $3)",
    [agentId, agentName, `zz${agentId}`],
  );
  const { page } = await h.session();
  const frames = await recordFrames(page);
  const httpReads = recordHttpReads(page, [KEY]);
  await boot(page, pathUrl(`/agents/agents/ag/${agentId}`), {
    marker: `text=${agentName}`,
    timeoutMs: 120_000,
    settleMs: 800,
  });
  httpReads.length = 0;
  await waitFor(
    async () => frames.some((f) => f.kind === "sub-ack" && f.key === KEY),
    (subscribed) => subscribed,
    { timeoutMs: 60_000 },
  );
  const measureFrom = frames.length;
  const upsertWhere = async (at: number, ok: (row: LaunchRow) => boolean) =>
    waitFor(
      async () => {
        for (const f of framesOf(frames, KEY, at)) {
          const hit = f.upserts?.find(([k]) => k === launchId);
          if (hit && ok(hit[1] as LaunchRow)) return hit[1] as LaunchRow;
        }
        return undefined;
      },
      (row) => row !== undefined,
      { timeoutMs: 15_000 },
    );

  let at = frames.length;
  await db.query(
    "INSERT INTO agent_launches (id, agent_id, task_id) VALUES ($1, $2, $3)",
    [launchId, agentId, taskId],
  );
  const entered = await upsertWhere(at, () => true);
  r.eq(
    "a new launch arrives as an upsert of its row (no latest conversation)",
    [
      entered.value?.latestConversation,
      entered.value?.latestConversationStatus,
    ],
    [null, null],
  );

  // One transaction: the attempt and its conversation land together.
  at = frames.length;
  await db.query(
    `WITH a AS (
       INSERT INTO attempts (id, task_id, worktree_path)
       VALUES ($1, $2, $3) RETURNING id
     )
     INSERT INTO conversations (id, attempt_id, title, status, model, kind)
     SELECT $4, a.id, $5, 'working', $6, 'user' FROM a`,
    [
      attemptId,
      taskId,
      `/tmp/${attemptId}`,
      convId,
      `${convId} run`,
      FALLBACK_MODEL,
    ],
  );
  const working = await upsertWhere(
    at,
    (row) => row.latestConversation?.id === convId,
  );
  r.ok(
    "a conversation on the launch's task arrives as one upsert of the launch (`working`)",
    working.value?.latestConversationStatus === "working",
    JSON.stringify(framesOf(frames, KEY, at)).slice(0, 2000),
  );
  await snap(page, OUT, "21-launch-working");

  at = frames.length;
  await db.query(
    "UPDATE conversations SET status = 'done', ended_at = now() WHERE id = $1",
    [convId],
  );
  const closed = await upsertWhere(
    at,
    (row) => row.latestConversationStatus === "done",
  );
  r.ok("the conversation's close arrives as one upsert (`done`)", closed.ok);

  // W8: the conversation goes by FK cascade and resolves no task through the
  // deleted attempt; the rollup's attempts source reaches the task.
  at = frames.length;
  await db.query("DELETE FROM attempts WHERE id = $1", [attemptId]);
  const cleared = await upsertWhere(
    at,
    (row) => row.latestConversation === null,
  );
  r.ok(
    "the attempt's delete arrives as one upsert back to no latest conversation (W8)",
    cleared.ok,
  );

  at = frames.length;
  await db.query("DELETE FROM agent_launches WHERE id = $1", [launchId]);
  const gone = await waitFor(
    async () => deleted(frames, KEY, launchId, at),
    (d) => d,
    { timeoutMs: 15_000 },
  );
  r.ok("a launch delete arrives as a delete", gone.ok);

  const phase = framesOf(frames, KEY, measureFrom);
  r.ok(
    "no `agent-launches` frame re-sent the whole set, over the whole phase",
    phase.every((f) => f.value === undefined),
    phase
      .map((f) => `${f.kind ?? "?"}${f.value !== undefined ? "(value)" : ""}`)
      .join(", "),
  );
  r.eq(
    "no HTTP read of `agent-launches` after the agent pane's first paint",
    httpReads,
    [],
  );
}

interface ConversationRow {
  id?: string;
  status?: string;
  waitingFor?: string | null;
  taskTitle?: string;
}

/**
 * Step 22: the conversation lists and the by-id read. W9 first: a page opened
 * on a done conversation older than the newest gone window resolves it from
 * the `conversations.by-id` point read, with no REST call. Then, with the
 * page's lists live (the sidebar's queue reads `conversations-active` and the
 * gone window): a new `working` conversation arrives as an entrant of
 * `conversations-active`; a poller's `waiting_for` as one upsert carrying it;
 * a rename of its task as one upsert carrying the new `taskTitle`; its close
 * as a delete from the active set and an entrant of the gone window; its
 * delete as a delete from the window. Over the phase no `conversations-active`
 * frame re-sent the set, and no conversation list or by-id read went over
 * HTTP.
 */
async function conversationsPhase(
  r: Report,
  h: Harness,
  taskId: string,
  taskTitle: string,
): Promise<void> {
  const ACTIVE = "conversations-active";
  const GONE = "conversations-gone";
  const BY_ID = "conversations.by-id:rows";
  const attemptId = `${taskId}-catt`;
  const oldId = `${taskId}-old`;
  const oldTitle = `${oldId} long ago`;
  const liveId = `${taskId}-live`;

  // W9's subject: ended years before anything the gone window holds.
  await db.query(
    "INSERT INTO attempts (id, task_id, worktree_path) VALUES ($1, $2, $3)",
    [attemptId, taskId, `/tmp/${attemptId}`],
  );
  await db.query(
    `INSERT INTO conversations (id, attempt_id, title, status, model, kind, created_at, ended_at)
     VALUES ($1, $2, $3, 'done', $4, 'user', '2020-01-01T00:00:00Z', '2020-01-01T01:00:00Z')`,
    [oldId, attemptId, oldTitle, FALLBACK_MODEL],
  );
  const inWindow = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM conversations
      WHERE status = 'done' AND ended_at IS NOT NULL AND kind <> 'system'
        AND ended_at > '2020-01-01T01:00:00Z'`,
  );
  r.ok(
    "the old conversation is older than the newest 30 ended ones",
    Number(inWindow[0]?.n) >= 30,
    `ended after it: ${inWindow[0]?.n}`,
  );

  const { page } = await h.session();
  const frames = await recordFrames(page);
  const httpReads = recordHttpReads(page, [
    ACTIVE,
    GONE,
    "conversations.by-id",
  ]);
  // A REST read of the conversation (`GET /api/conversations/:id`) — the
  // fallback W9 deleted. Its sub-routes (the pane's `POST …/viewed`) are not.
  const restReads: string[] = [];
  page.on("request", (req) => {
    const path = new URL(req.url()).pathname;
    if (req.method() === "GET" && path === `/api/conversations/${oldId}`) {
      restReads.push(path);
    }
  });
  await boot(page, pathUrl(`/agents/c/${oldId}`), {
    marker: `text=${oldTitle}`,
    timeoutMs: 120_000,
    settleMs: 800,
  });
  r.ok(
    "W9: the old done conversation's pane resolves (its title paints)",
    true,
  );
  r.eq("W9: …with no REST read of the conversation", restReads, []);
  httpReads.length = 0;
  for (const key of [BY_ID, ACTIVE, GONE]) {
    await waitFor(
      async () => frames.some((f) => f.kind === "sub-ack" && f.key === key),
      (subscribed) => subscribed,
      { timeoutMs: 60_000 },
    );
  }
  const measureFrom = frames.length;
  const upsertWhere = async (
    key: string,
    at: number,
    ok: (row: ConversationRow) => boolean,
  ) =>
    waitFor(
      async () => {
        for (const f of framesOf(frames, key, at)) {
          const hit = f.upserts?.find(([k]) => k === liveId);
          if (hit && ok(hit[1] as ConversationRow))
            return hit[1] as ConversationRow;
        }
        return undefined;
      },
      (row) => row !== undefined,
      { timeoutMs: 15_000 },
    );

  let at = frames.length;
  await db.query(
    `INSERT INTO conversations (id, attempt_id, title, status, model, kind)
     VALUES ($1, $2, $3, 'working', $4, 'user')`,
    [liveId, attemptId, `${liveId} run`, FALLBACK_MODEL],
  );
  const entered = await upsertWhere(ACTIVE, at, () => true);
  r.eq(
    "a new conversation arrives as an entrant of `conversations-active`",
    [entered.value?.status, entered.value?.taskTitle],
    ["working", taskTitle],
  );

  at = frames.length;
  await db.query(
    "UPDATE conversations SET waiting_for = 'permission' WHERE id = $1",
    [liveId],
  );
  const waiting = await upsertWhere(
    ACTIVE,
    at,
    (row) => row.waitingFor === "permission",
  );
  r.ok(
    "a poller's `waiting_for` arrives as one upsert carrying it",
    waiting.ok,
  );

  at = frames.length;
  await db.query("UPDATE tasks SET title = $2 WHERE id = $1", [
    taskId,
    `${taskTitle} renamed`,
  ]);
  const renamed = await upsertWhere(
    ACTIVE,
    at,
    (row) => row.taskTitle === `${taskTitle} renamed`,
  );
  r.ok("a task rename arrives as one upsert carrying `taskTitle`", renamed.ok);

  at = frames.length;
  await db.query(
    "UPDATE conversations SET status = 'done', ended_at = now() WHERE id = $1",
    [liveId],
  );
  const left = await waitFor(
    async () => deleted(frames, ACTIVE, liveId, at),
    (d) => d,
    { timeoutMs: 15_000 },
  );
  r.ok("a close arrives as a delete from `conversations-active`", left.ok);
  const ended = await upsertWhere(GONE, at, (row) => row.status === "done");
  r.ok("…and as an entrant of the gone window", ended.ok);

  at = frames.length;
  await db.query("DELETE FROM conversations WHERE id = $1", [liveId]);
  const removed = await waitFor(
    async () => deleted(frames, GONE, liveId, at),
    (d) => d,
    { timeoutMs: 15_000 },
  );
  r.ok("a conversation delete arrives as a delete from the window", removed.ok);

  const phase = framesOf(frames, ACTIVE, measureFrom);
  r.ok(
    "no `conversations-active` frame re-sent the whole set, over the whole phase",
    phase.every((f) => f.value === undefined),
    phase
      .map((f) => `${f.kind ?? "?"}${f.value !== undefined ? "(value)" : ""}`)
      .join(", "),
  );
  r.eq(
    "no HTTP read of a conversation list or the by-id read after first paint",
    httpReads,
    [],
  );
  await snap(page, OUT, "22-conversations");

  await bootCostOfByIdPane(r, h, attemptId);
}

/**
 * The by-id pane's first-paint cost, pinned (step 22, review): the pane
 * resolves from the `conversations.by-id` point read, which is lookup-only and
 * so never in the boot snapshot. A reload of an ACTIVE conversation's pane —
 * which resolved at first paint from the boot-hydrated `conversations-active`
 * before step 22 — now waits one by-id answer (an HTTP read or the socket's
 * sub-ack, whichever lands first) after the boot snapshot. Checked: the pane
 * paints only after that answer (so a change that makes first paint resolve
 * it from hydrated rows fails here and is re-pinned on purpose); measured and
 * reported: the snapshot → answer → paint latencies.
 */
async function bootCostOfByIdPane(
  r: Report,
  h: Harness,
  attemptId: string,
): Promise<void> {
  const bootId = `${attemptId}-boot`;
  const bootTitle = `${bootId} reloaded`;
  await db.query(
    `INSERT INTO conversations (id, attempt_id, title, status, model, kind)
     VALUES ($1, $2, $3, 'working', $4, 'user')`,
    [bootId, attemptId, bootTitle, FALLBACK_MODEL],
  );
  const { page } = await h.session();
  const t0 = Date.now();
  let snapshotAt: number | undefined;
  let answerAt: number | undefined;
  let answeredBy: string | undefined;
  const answered = (by: string) => {
    if (answerAt !== undefined) return;
    answerAt = Date.now();
    answeredBy = by;
  };
  page.on("response", (res) => {
    const path = new URL(res.url()).pathname;
    if (path.startsWith("/api/resources/boot-snapshot"))
      snapshotAt ??= Date.now();
    else if (path.startsWith("/api/resources/conversations.by-id"))
      answered("http");
  });
  const tap = await tapSharedSocket(page);
  tap.onFrame((f) => {
    if (!f.data.includes(bootId)) return;
    const frame = JSON.parse(f.data) as Frame;
    if (frame.kind === "sub-ack" && frame.key === "conversations.by-id:rows")
      answered("sub-ack");
  });
  await page.goto(pathUrl(`/agents/c/${bootId}`), {
    waitUntil: "domcontentloaded",
    timeout: 120_000,
  });
  // Inside the conversation pane's box: the sidebar's queue lists the same
  // title from the boot-hydrated active set, at first paint.
  await page
    .locator(`[data-pane-id="conversation"] >> text=${bootTitle}`)
    .first()
    .waitFor({ state: "visible", timeout: 120_000 });
  const paintedAt = Date.now();
  r.ok(
    "boot: the reloaded active conversation's pane paints only after its by-id answer (the known first-paint cost)",
    answerAt !== undefined && answerAt <= paintedAt,
    `answered by ${answeredBy ?? "nothing"}`,
  );
  const ms = (at: number | undefined) =>
    at === undefined ? "?" : `${at - t0} ms`;
  const latency = `boot snapshot ${ms(snapshotAt)}, by-id answer ${ms(answerAt)} (${answeredBy ?? "?"}), pane painted ${ms(paintedAt)}; answer after snapshot ${
    snapshotAt !== undefined && answerAt !== undefined
      ? `${answerAt - snapshotAt} ms`
      : "?"
  }`;
  // A measurement, printed whatever the verdict (a passing check prints no detail).
  console.log(`      by-id pane boot latency (from navigation): ${latency}`);
  r.ok(
    "boot: by-id pane latency measured (from navigation)",
    snapshotAt !== undefined,
    latency,
  );
  await snap(page, OUT, "22-boot-by-id");
}

try {
  await db.query("DELETE FROM tasks WHERE id LIKE $1", [`${SEED_PREFIX}%`]);
  await db.query("DELETE FROM agents WHERE id LIKE $1", [`${SEED_PREFIX}%`]);
  const tag = randomBytes(3).toString("hex");
  const taskId = `${SEED_PREFIX}${tag}`;
  const taskTitle = `${taskId} task`;
  await db.query(
    "INSERT INTO tasks (id, title, title_auto, rank, mandate) VALUES ($1, $2, false, $3, '{}')",
    [taskId, taskTitle, `zz${tag}`],
  );

  await withBrowser(async (h) => {
    const r = report("task tree — live end to end");
    const { page } = await h.session();
    const frames = await recordFrames(page);
    const httpReads = recordHttpReads(page);

    // The task's detail pane: its attempt sections read the `attempts` set.
    await boot(page, pathUrl(`/agents/tasks/t/${taskId}`), {
      marker: `text=${taskTitle}`,
      timeoutMs: 120_000,
      settleMs: 800,
    });
    // First paint: from here on, every HTTP read of a tree key counts — the
    // window up to the socket's subscribe included, which is exactly where a
    // missing boot hydration or a refetch fallback would show.
    httpReads.length = 0;
    // The socket's own subscribe can land seconds after first paint on a
    // contended host (a burst of sub-acks, values included, for every key the
    // page reads). The frame-delta window starts once every tree key is live
    // on the socket, so that burst is never read as a re-send.
    for (const key of TREE_KEYS) {
      await waitFor(
        async () => frames.some((f) => f.kind === "sub-ack" && f.key === key),
        (subscribed) => subscribed,
        { timeoutMs: 60_000 },
      );
    }
    await page.evaluate(() => {
      (window as unknown as { __noReload?: boolean }).__noReload = true;
    });
    await snap(page, OUT, "0-seeded");
    const measureFrom = frames.length;

    await categoriesPhase(r, page, frames, taskId, measureFrom);
    await tasksPhase(r, page, frames, taskId, measureFrom);
    await attemptsPhase(r, page, frames, taskId, measureFrom);

    r.eq(
      "no HTTP read of a tree key after first paint (socket only)",
      httpReads,
      [],
    );
    r.ok(
      "the page never reloaded",
      await page.evaluate(
        () =>
          (window as unknown as { __noReload?: boolean }).__noReload === true,
      ),
    );

    // A reload's first paint is current: the boot snapshot carries the set.
    const snapshot = page.waitForResponse((res) =>
      new URL(res.url()).pathname.startsWith("/api/resources/boot-snapshot"),
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    const body = await (await snapshot).text();
    r.ok(
      "the reload's boot snapshot carries the seeded task's row",
      body.includes(`"id":"${taskId}"`),
    );
    r.ok(
      "the reload's boot snapshot carries the task's current category",
      body.includes(`"taskId":"${taskId}","category":"agents"`) ||
        body.includes(`"category":"agents","taskId":"${taskId}"`),
    );
    await snap(page, OUT, "1-reloaded");
    await launchesPhase(r, h, taskId);
    await conversationsPhase(r, h, taskId, taskTitle);
    await r.finish();
  });
} finally {
  await cleanup();
}
