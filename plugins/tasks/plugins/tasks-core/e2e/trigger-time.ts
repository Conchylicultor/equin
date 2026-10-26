/**
 * Trigger-time baseline for the task tree's tables (step 16·0, §4.3 of
 * research/2026-10-06-global-scoped-change-routing-p8-v3.md — Risk 4): what
 * each representative write costs in triggers — the change feed's
 * `live_state_*`, the rollups' `*_maintain`, the derived `updated_at`, and the
 * FK cascades — measured on the deploy THIS checkout published (its database
 * is a fork of main's, so the row counts are main's).
 *
 * Method, per DML: inside `BEGIN … ROLLBACK`, `EXPLAIN (ANALYZE, FORMAT JSON)`
 * the statement — it really runs, AFTER STATEMENT triggers and cascades
 * included, and Postgres reports each trigger's time and calls — then roll it
 * back, so nothing it wrote survives. `--repeats` runs (default 3), the median
 * reported. `pg_notify`'s cost lands at COMMIT, which no rolled-back statement
 * reaches, so one more measurement COMMITs throwaway rows (a task, its
 * attempt, conversation, push, dependency and category — inert: the task is
 * dropped, the conversation done) and times the COMMIT round trip against an
 * empty transaction's, then deletes them.
 *
 * Re-run after 16b.2 and after each of steps 18–22, and append the table to
 * the plan's As-landed section. Refuses main (it commits throwaway rows).
 *
 * The fixture — which attempt, conversation, tasks, dependency and category
 * row each DML touches, and how many rows the attempt's delete cascades to —
 * is printed and written to the JSON, because the cost depends on it (the
 * cascade delete most of all). Unpinned, each row is the newest that fits its
 * role, so a grown or re-forked database can pick a different one; a re-run
 * meant to compare against a baseline PINS the baseline's rows — `--pin
 * <baseline.json>` takes the whole fixture from an earlier `--json` record, and
 * `--attempt`, `--conversation`, `--other-task`, `--dependency-task`,
 * `--dependency-on` and `--category-task` pin one row each (over `--pin`). A
 * pinned row that is gone, or no longer fits its role, refuses the run. Compare
 * the fan-out too: the same attempt can cascade to more rows later.
 *
 *   ./equin run plugins/tasks/plugins/tasks-core/e2e/trigger-time.ts [--repeats 3] [--json /tmp/trigger-time.json] [--pin <baseline.json>]
 */
import { readFileSync, writeFileSync } from "node:fs";
import { Client } from "pg";
import { MAIN_WORKTREE_NAME } from "@plugins/infra/plugins/namespace/core";
import {
  buildConnectionString,
  readDatabaseConfig,
} from "@plugins/database/core";
import {
  arg,
  numArg,
  targetNamespace,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

const REPEATS = numArg("repeats", 3);
const JSON_OUT = arg("json");
/** Every row this script commits starts with it, so a killed run's leftovers can be swept. */
const PREFIX = "trigger-time-";

// ── The connection: ONE session (BEGIN / EXPLAIN / ROLLBACK must share it) ──

const namespace = String(targetNamespace());
if (namespace === MAIN_WORKTREE_NAME) {
  throw new Error(
    "refusing to measure on main's database — this script commits throwaway rows; run it against this checkout's worktree deploy",
  );
}
const config = readDatabaseConfig();
const client = new Client({
  connectionString: buildConnectionString(
    {
      host: process.env.PGHOST ?? config.connection.host,
      port: Number(process.env.PGPORT ?? config.connection.port),
      user: process.env.PGUSER ?? config.connection.user,
    },
    namespace,
  ),
});
await client.connect();

type Row = Record<string, unknown>;
async function q<R extends Row = Row>(
  sql: string,
  params: readonly unknown[] = [],
): Promise<R[]> {
  return (await client.query<R>(sql, [...params])).rows;
}

function one<R>(rows: R[], what: string): R {
  const row = rows[0];
  if (row === undefined) {
    throw new Error(
      `no ${what} in ${namespace}'s database — the measurement needs main's data (a forked worktree database)`,
    );
  }
  return row;
}

// ── Fixture rows: real ones, so every trigger does its real work ────────────

/** A killed run's committed leftovers (the task cascades to everything else). */
async function sweep(): Promise<void> {
  await q(`DELETE FROM tasks WHERE id LIKE $1`, [`${PREFIX}%`]);
}
await sweep();

/** Which rows the DMLs touch — recorded with every run, pinnable on the next. */
interface Fixture {
  /** Inserted beside, deleted (cascade), moved to `otherTask`. */
  attempt: string;
  /** The attempt's task (derived from it, never pinned on its own). */
  task: string;
  /** A non-system conversation of `attempt`: its status / waiting_for updated, a push inserted on it. */
  conversation: string;
  /** A task with no dependency edge to `task`: the inserted edge's target, the moved attempt's new task. */
  otherTask: string;
  /** An existing task_dependencies row, deleted. */
  dependency: { task: string; dependsOn: string };
  /** A task with a tasks_ext_category row, updated. */
  categoryTask: string;
}

/** The fixture `--pin` names (an earlier run's `--json` record), overridden per row by its own flag. */
function pinned(): Partial<Omit<Fixture, "task">> & {
  /** The `--pin` record's task for its attempt — the attempt must still be on it. */
  attemptTask?: string;
} {
  const file = arg("pin");
  let base: Partial<Fixture> = {};
  if (file !== undefined) {
    const record = JSON.parse(readFileSync(file, "utf8")) as {
      fixture?: Fixture;
    };
    if (record.fixture === undefined) {
      throw new Error(
        `--pin ${file}: no \`fixture\` in it — pass the --json record of a run of this script`,
      );
    }
    base = record.fixture;
  }
  const flagged = (name: string, fallback: string | undefined) => {
    const v = arg(name);
    if (v === "") throw new Error(`--${name} needs an id`);
    return v ?? fallback;
  };
  const depTask = flagged("dependency-task", base.dependency?.task);
  const depOn = flagged("dependency-on", base.dependency?.dependsOn);
  if ((depTask === undefined) !== (depOn === undefined)) {
    throw new Error(
      "--dependency-task and --dependency-on pin one task_dependencies row together — give both",
    );
  }
  const attemptFlag = flagged("attempt", undefined);
  return {
    attempt: attemptFlag ?? base.attempt,
    ...(attemptFlag === undefined && base.task !== undefined
      ? { attemptTask: base.task }
      : {}),
    conversation: flagged("conversation", base.conversation),
    otherTask: flagged("other-task", base.otherTask),
    categoryTask: flagged("category-task", base.categoryTask),
    ...(depTask !== undefined && depOn !== undefined
      ? { dependency: { task: depTask, dependsOn: depOn } }
      : {}),
  };
}

/** A pinned row that is gone or no longer fits its role: the run would measure something else. */
function gone(what: string, id: string, why: string): never {
  throw new Error(
    `pinned ${what} ${id} ${why} — this run cannot measure the baseline's rows; re-baseline without the pin, and say so beside the numbers`,
  );
}

const pin = pinned();

// The attempt: the newest with a non-system conversation and a push, whose
// task has another attempt with a conversation — deleting it makes the task's
// latest conversation fall back to an older one (real rollup work, not a
// no-op). A pinned one must still be exactly that.
const ATTEMPT_ROLE = `
  EXISTS (SELECT 1 FROM conversations c WHERE c.attempt_id = a.id AND c.kind <> 'system')
  AND EXISTS (SELECT 1 FROM pushes p WHERE p.attempt_id = a.id)
  AND EXISTS (SELECT 1 FROM attempts a2 JOIN conversations c2 ON c2.attempt_id = a2.id
               WHERE a2.task_id = a.task_id AND a2.id <> a.id)`;
let attempt: { id: string; task_id: string };
if (pin.attempt !== undefined) {
  const [row] = await q<{ id: string; task_id: string; fits: boolean }>(
    `SELECT a.id, a.task_id, (${ATTEMPT_ROLE}) AS fits FROM attempts a WHERE a.id = $1`,
    [pin.attempt],
  );
  if (row === undefined) gone("attempt", pin.attempt, "is gone");
  if (!row.fits) {
    gone(
      "attempt",
      pin.attempt,
      "no longer has a non-system conversation, a push, and a sibling attempt with a conversation",
    );
  }
  attempt = row;
} else {
  attempt = one(
    await q<{ id: string; task_id: string }>(`
      SELECT a.id, a.task_id FROM attempts a WHERE ${ATTEMPT_ROLE}
       ORDER BY a.created_at DESC LIMIT 1`),
    "attempt with a conversation and a push on a task with an older attempt",
  );
}

let conversation: { id: string; model: string };
if (pin.conversation !== undefined) {
  const [row] = await q<{
    id: string;
    model: string;
    attempt_id: string;
    kind: string;
  }>(`SELECT id, model, attempt_id, kind FROM conversations WHERE id = $1`, [
    pin.conversation,
  ]);
  if (row === undefined) gone("conversation", pin.conversation, "is gone");
  if (row.attempt_id !== attempt.id || row.kind === "system") {
    gone(
      "conversation",
      pin.conversation,
      `is not a non-system conversation of attempt ${attempt.id}`,
    );
  }
  conversation = row;
} else {
  conversation = one(
    await q<{ id: string; model: string }>(
      `SELECT id, model FROM conversations WHERE attempt_id = $1 AND kind <> 'system'
        ORDER BY created_at DESC LIMIT 1`,
      [attempt.id],
    ),
    `non-system conversation of attempt ${attempt.id}`,
  );
}

const NO_EDGE = `NOT EXISTS (SELECT 1 FROM task_dependencies d
                  WHERE (d.task_id = $1 AND d.depends_on_task_id = t.id)
                     OR (d.task_id = t.id AND d.depends_on_task_id = $1))`;
let otherTask: string;
if (pin.otherTask !== undefined) {
  const [row] = await q<{ fits: boolean }>(
    `SELECT (t.id <> $1 AND ${NO_EDGE}) AS fits FROM tasks t WHERE t.id = $2`,
    [attempt.task_id, pin.otherTask],
  );
  if (row === undefined) gone("other task", pin.otherTask, "is gone");
  if (!row.fits) {
    gone(
      "other task",
      pin.otherTask,
      `is task ${attempt.task_id} itself or has a dependency edge to it`,
    );
  }
  otherTask = pin.otherTask;
} else {
  otherTask = one(
    await q<{ id: string }>(
      `SELECT t.id FROM tasks t
        WHERE t.id <> $1 AND t.id NOT LIKE $2 AND ${NO_EDGE}
        ORDER BY t.created_at DESC LIMIT 1`,
      [attempt.task_id, `${PREFIX}%`],
    ),
    "second task",
  ).id;
}

let dependency: { task: string; dependsOn: string };
if (pin.dependency !== undefined) {
  const [row] = await q(
    `SELECT 1 FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2`,
    [pin.dependency.task, pin.dependency.dependsOn],
  );
  if (row === undefined) {
    gone(
      "task dependency",
      `${pin.dependency.task} → ${pin.dependency.dependsOn}`,
      "is gone",
    );
  }
  dependency = pin.dependency;
} else {
  const row = one(
    await q<{ task_id: string; depends_on_task_id: string }>(
      `SELECT task_id, depends_on_task_id FROM task_dependencies ORDER BY created_at DESC LIMIT 1`,
    ),
    "task dependency",
  );
  dependency = { task: row.task_id, dependsOn: row.depends_on_task_id };
}

let category: { parent_id: string; category: string };
if (pin.categoryTask !== undefined) {
  const [row] = await q<{ parent_id: string; category: string }>(
    `SELECT parent_id, category FROM tasks_ext_category WHERE parent_id = $1`,
    [pin.categoryTask],
  );
  if (row === undefined) {
    gone("category task", pin.categoryTask, "has no tasks_ext_category row");
  }
  category = row;
} else {
  category = one(
    await q<{ parent_id: string; category: string }>(
      `SELECT parent_id, category FROM tasks_ext_category
        ORDER BY (parent_id = $1) DESC, updated_at DESC LIMIT 1`,
      [attempt.task_id],
    ),
    "task category row",
  );
}
const otherCategory =
  category.category === "wishes" ? "conversations" : "wishes";

const fixture: Fixture = {
  attempt: attempt.id,
  task: attempt.task_id,
  conversation: conversation.id,
  otherTask,
  dependency,
  categoryTask: category.parent_id,
};
if (pin.attemptTask !== undefined && pin.attemptTask !== attempt.task_id) {
  gone(
    "attempt",
    attempt.id,
    `has moved from task ${pin.attemptTask} to ${attempt.task_id}`,
  );
}

// ── The attempt's cascade fan-out (what `DELETE attempt` really deletes) ────

interface FanOut {
  /** `parent → child` along the FK, from `attempts`. */
  path: string;
  constraint: string;
  action: "cascade" | "set null";
  rows: number;
}

/**
 * Every row the attempt's delete reaches through ON DELETE CASCADE / SET NULL
 * foreign keys, per edge, read off pg_constraint — so a new cascading table
 * shows up here without editing this script. Counted BEFORE anything runs.
 */
async function fanOutOf(attemptId: string): Promise<FanOut[]> {
  const edges = await q<{
    conname: string;
    child: string;
    child_col: string | null;
    parent: string;
    parent_col: string | null;
    action: string;
    cols: number;
  }>(`
    SELECT c.conname, cl.relname AS child, a.attname AS child_col,
           pl.relname AS parent, pa.attname AS parent_col,
           c.confdeltype AS action, array_length(c.conkey, 1) AS cols
      FROM pg_constraint c
      JOIN pg_class cl ON cl.oid = c.conrelid
      JOIN pg_class pl ON pl.oid = c.confrelid
      LEFT JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      LEFT JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND c.confdeltype IN ('c', 'n')
       AND cl.relnamespace = 'public'::regnamespace
     ORDER BY pl.relname, cl.relname, c.conname`);
  const ident = (name: string) => `"${name.replaceAll('"', '""')}"`;
  const out: FanOut[] = [];
  const walk = async (
    table: string,
    pred: string,
    path: string,
    depth: number,
  ): Promise<void> => {
    if (depth > 8) {
      throw new Error(
        `cascade from attempts deeper than 8 at ${path} — a cycle?`,
      );
    }
    for (const e of edges.filter((x) => x.parent === table)) {
      if (e.cols !== 1 || e.child_col === null || e.parent_col === null) {
        throw new Error(
          `${e.conname}: a multi-column FK into ${table} — the fan-out count reads single-column FKs only; extend it`,
        );
      }
      const childPred = `${ident(e.child_col)} IN (SELECT ${ident(e.parent_col)} FROM ${ident(table)} WHERE ${pred})`;
      const [row] = await q<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${ident(e.child)} WHERE ${childPred}`,
        [attemptId],
      );
      const rows = Number(row?.n ?? "0");
      const childPath = `${path} → ${e.child}`;
      const action = e.action === "c" ? "cascade" : "set null";
      out.push({ path: childPath, constraint: e.conname, action, rows });
      if (action === "cascade" && rows > 0) {
        await walk(e.child, childPred, childPath, depth + 1);
      }
    }
  };
  await walk("attempts", `${ident("id")} = $1`, "attempts", 0);
  return out;
}
const fanOut = await fanOutOf(attempt.id);

// ── The DML set (§4.3) ──────────────────────────────────────────────────────

interface Case {
  name: string;
  sql: string;
  params: readonly unknown[];
}

const ID = `${PREFIX}x`;
const CASES: Case[] = [
  {
    name: "UPDATE tasks status (held_at)",
    sql: `UPDATE tasks SET held_at = CASE WHEN held_at IS NULL THEN now() ELSE NULL END WHERE id = $1`,
    params: [attempt.task_id],
  },
  {
    name: "INSERT attempt",
    sql: `INSERT INTO attempts (id, task_id, worktree_path) VALUES ($1, $2, '/tmp/trigger-time')`,
    params: [`${ID}-att`, attempt.task_id],
  },
  {
    name: "UPDATE conversations status",
    sql: `UPDATE conversations SET status = CASE WHEN status = 'waiting' THEN 'working' ELSE 'waiting' END WHERE id = $1`,
    params: [conversation.id],
  },
  {
    name: "UPDATE conversations waiting_for only",
    sql: `UPDATE conversations SET waiting_for = CASE WHEN waiting_for IS NULL THEN 'trigger-time' ELSE NULL END WHERE id = $1`,
    params: [conversation.id],
  },
  {
    name: "INSERT pushes",
    sql: `INSERT INTO pushes (id, sha, message, push_id, attempt_id, conversation_id) VALUES ($1, $1, 'trigger-time', $1, $2, $3)`,
    params: [`${ID}-push`, attempt.id, conversation.id],
  },
  {
    name: "INSERT task_dependencies",
    sql: `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)`,
    params: [attempt.task_id, otherTask],
  },
  {
    name: "DELETE task_dependencies",
    sql: `DELETE FROM task_dependencies WHERE task_id = $1 AND depends_on_task_id = $2`,
    params: [dependency.task, dependency.dependsOn],
  },
  {
    name: "UPDATE tasks_ext_category",
    sql: `UPDATE tasks_ext_category SET category = $2 WHERE parent_id = $1`,
    params: [category.parent_id, otherCategory],
  },
  {
    name: "DELETE attempt (cascade)",
    sql: `DELETE FROM attempts WHERE id = $1`,
    params: [attempt.id],
  },
  {
    name: "UPDATE attempts.task_id",
    sql: `UPDATE attempts SET task_id = $2 WHERE id = $1`,
    params: [attempt.id, otherTask],
  },
];

// ── EXPLAIN ANALYZE, rolled back ────────────────────────────────────────────

interface ExplainTrigger {
  "Trigger Name": string;
  "Constraint Name"?: string;
  Relation?: string;
  Time: number;
  Calls: number;
}
interface ExplainResult {
  "Planning Time": number;
  "Execution Time": number;
  Triggers?: ExplainTrigger[];
}

interface Run {
  executionMs: number;
  planningMs: number;
  /** Trigger label → its time and calls in this run. */
  triggers: Map<string, { ms: number; calls: number }>;
}

/** A trigger's name as a person reads it (an FK trigger by its constraint). */
function triggerLabel(t: ExplainTrigger): string {
  const name = t["Constraint Name"]
    ? `FK ${t["Constraint Name"]}`
    : t["Trigger Name"];
  return t.Relation ? `${t.Relation}: ${name}` : name;
}

async function explainOnce(c: Case): Promise<Run> {
  await q("BEGIN");
  let out: ExplainResult;
  try {
    await q("SET LOCAL statement_timeout = '60s'");
    const rows = await q<{ "QUERY PLAN": ExplainResult[] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${c.sql}`,
      c.params,
    );
    out = one(one(rows, `EXPLAIN output for ${c.name}`)["QUERY PLAN"], "plan");
  } finally {
    await q("ROLLBACK");
  }
  const triggers = new Map<string, { ms: number; calls: number }>();
  for (const t of out.Triggers ?? []) {
    const label = triggerLabel(t);
    const prev = triggers.get(label);
    triggers.set(label, {
      ms: (prev?.ms ?? 0) + t.Time,
      calls: (prev?.calls ?? 0) + t.Calls,
    });
  }
  return {
    executionMs: out["Execution Time"],
    planningMs: out["Planning Time"],
    triggers,
  };
}

function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median of nothing");
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const ms = (v: number): string => v.toFixed(3);

interface CaseSummary {
  name: string;
  sql: string;
  params: readonly unknown[];
  executionMs: number;
  planningMs: number;
  triggerMs: number;
  runsExecutionMs: number[];
  triggers: { label: string; ms: number; calls: number }[];
}

const summaries: CaseSummary[] = [];
for (const c of CASES) {
  const runs: Run[] = [];
  for (let i = 0; i < REPEATS; i++) runs.push(await explainOnce(c));
  const labels = [...new Set(runs.flatMap((r) => [...r.triggers.keys()]))];
  const triggers = labels.map((label) => ({
    label,
    ms: median(runs.map((r) => r.triggers.get(label)?.ms ?? 0)),
    calls: median(runs.map((r) => r.triggers.get(label)?.calls ?? 0)),
  }));
  summaries.push({
    name: c.name,
    sql: c.sql,
    params: c.params,
    executionMs: median(runs.map((r) => r.executionMs)),
    planningMs: median(runs.map((r) => r.planningMs)),
    triggerMs: median(
      runs.map((r) => [...r.triggers.values()].reduce((s, t) => s + t.ms, 0)),
    ),
    runsExecutionMs: runs.map((r) => r.executionMs),
    triggers,
  });
}

// ── One timed COMMIT on throwaway rows (pg_notify lands here) ───────────────

async function timedCommit(write: (i: number) => Promise<void>, i: number) {
  await q("BEGIN");
  try {
    await write(i);
  } catch (err) {
    await q("ROLLBACK");
    throw err;
  }
  const t0 = performance.now();
  await q("COMMIT");
  return performance.now() - t0;
}

async function writeThrowaway(i: number): Promise<void> {
  const task = `${PREFIX}${i}`;
  const att = `${task}-att`;
  const conv = `${task}-conv`;
  await q(
    // A real task's rank: every reader decodes it, so it must be a valid one.
    `INSERT INTO tasks (id, title, rank, title_auto, dropped_at)
     SELECT $1, 'trigger-time throwaway', rank, false, now() FROM tasks WHERE id = $2`,
    [task, attempt.task_id],
  );
  await q(
    `INSERT INTO attempts (id, task_id, worktree_path) VALUES ($1, $2, '/tmp/trigger-time')`,
    [att, task],
  );
  await q(
    `INSERT INTO conversations (id, attempt_id, model, status, ended_at, title) VALUES ($1, $2, $3, 'done', now(), 'trigger-time throwaway')`,
    [conv, att, conversation.model],
  );
  await q(
    `INSERT INTO pushes (id, sha, message, push_id, attempt_id, conversation_id) VALUES ($1, $1, 'trigger-time', $1, $2, $3)`,
    [`${task}-push`, att, conv],
  );
  await q(
    `INSERT INTO task_dependencies (task_id, depends_on_task_id) VALUES ($1, $2)`,
    [task, attempt.task_id],
  );
  await q(
    `INSERT INTO tasks_ext_category (parent_id, category) VALUES ($1, 'wishes')`,
    [task],
  );
}

const commitWrites: number[] = [];
const commitEmpty: number[] = [];
try {
  for (let i = 0; i < REPEATS; i++) {
    commitEmpty.push(
      await timedCommit(async () => {
        await q("SELECT 1");
      }, i),
    );
    commitWrites.push(await timedCommit(writeThrowaway, i));
    await sweep();
  }
} finally {
  await sweep();
}

// ── Report ──────────────────────────────────────────────────────────────────

const counts = one(
  await q<Record<string, string>>(`
    SELECT (SELECT count(*) FROM tasks)::text AS tasks,
           (SELECT count(*) FROM attempts)::text AS attempts,
           (SELECT count(*) FROM conversations)::text AS conversations,
           (SELECT count(*) FROM pushes)::text AS pushes,
           (SELECT count(*) FROM task_dependencies)::text AS task_dependencies,
           (SELECT count(*) FROM tasks_ext_category)::text AS tasks_ext_category,
           current_setting('server_version') AS pg`),
  "row counts",
);
await client.end();

function pinFlags(f: Fixture): string {
  return [
    `--attempt ${f.attempt}`,
    `--conversation ${f.conversation}`,
    `--other-task ${f.otherTask}`,
    `--dependency-task ${f.dependency.task}`,
    `--dependency-on ${f.dependency.dependsOn}`,
    `--category-task ${f.categoryTask}`,
  ].join(" ");
}

const lines: string[] = [];
lines.push(
  `Trigger time on ${namespace} — ${new Date().toISOString()} — median of ${REPEATS}`,
  `rows: ${Object.entries(counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ")}`,
  `fixture: attempt ${fixture.attempt} (task ${fixture.task}), conversation ${fixture.conversation}, other task ${fixture.otherTask}, dependency ${fixture.dependency.task} → ${fixture.dependency.dependsOn}, category task ${fixture.categoryTask}`,
  `DELETE attempt fan-out (rows, before any DML): ${
    fanOut
      .filter((f) => f.rows > 0)
      .map(
        (f) =>
          `${f.path} ${f.rows}${f.action === "set null" ? " (set null)" : ""}`,
      )
      .join(", ") || "none"
  }`,
  `pin these rows on a re-run: --pin <this run's --json>, or ${pinFlags(fixture)}`,
  "",
  "| DML | exec ms | triggers ms | plan ms | runs (exec ms) |",
  "|---|---|---|---|---|",
);
for (const s of summaries) {
  lines.push(
    `| ${s.name} | ${ms(s.executionMs)} | ${ms(s.triggerMs)} | ${ms(s.planningMs)} | ${s.runsExecutionMs.map(ms).join(" / ")} |`,
  );
}
lines.push("", "Per trigger (median ms × calls):");
for (const s of summaries) {
  lines.push(
    `- ${s.name}  [${s.params.map((p) => JSON.stringify(p)).join(", ")}]`,
  );
  for (const t of [...s.triggers].sort((a, b) => b.ms - a.ms)) {
    lines.push(`    ${ms(t.ms).padStart(9)} ms ×${t.calls}  ${t.label}`);
  }
}
lines.push(
  "",
  `COMMIT round trip (median ms): throwaway rows ${ms(median(commitWrites))} [${commitWrites.map(ms).join(" / ")}], empty transaction ${ms(median(commitEmpty))} [${commitEmpty.map(ms).join(" / ")}]`,
);
console.log(lines.join("\n"));

if (JSON_OUT) {
  writeFileSync(
    JSON_OUT,
    `${JSON.stringify(
      {
        namespace,
        at: new Date().toISOString(),
        repeats: REPEATS,
        counts,
        fixture,
        fanOut,
        cases: summaries,
        commit: { writesMs: commitWrites, emptyMs: commitEmpty },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`wrote ${JSON_OUT}`);
}
