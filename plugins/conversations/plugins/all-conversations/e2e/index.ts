/**
 * Seeding for the conversation-list e2e scripts (`list-live-verify` here,
 * History's `history-live-verify`): one task with one attempt and two
 * conversations — a `user` one and a `system` one — written straight into the
 * deploy's database.
 *
 * The rows are REACTOR-INERT, so nothing in the backend acts on them while a
 * script watches: the task's title is not machine-made (`title_auto = false`,
 * so no title upgrade runs), and both conversations are closed (`done`, with
 * `ended_at`) — no poller, hibernation or resume touches them. Deleting the
 * task cascades its attempt and conversations away.
 */
import { randomBytes } from "node:crypto";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import {
  agentFetch,
  type DeployDb,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";

/** Every seeded id starts with this, so a crashed run's leftovers are swept by prefix. */
export const SEED_PREFIX = "e2e-convlist-";

export interface SeededConversations {
  taskId: string;
  taskTitle: string;
  attemptId: string;
  user: { id: string; title: string };
  system: { id: string; title: string };
}

/** Delete every task a previous run seeded (its attempts and conversations cascade). */
export async function sweepSeeded(db: DeployDb): Promise<void> {
  await db.query("DELETE FROM tasks WHERE id LIKE $1", [`${SEED_PREFIX}%`]);
}

export async function seedConversations(
  db: DeployDb,
): Promise<SeededConversations> {
  const tag = randomBytes(3).toString("hex");
  const taskId = `${SEED_PREFIX}${tag}`;
  const taskTitle = `${taskId} task`;
  const attemptId = `${taskId}-att`;
  const user = { id: `${taskId}-user`, title: `${taskId} user conv` };
  const system = { id: `${taskId}-system`, title: `${taskId} system conv` };
  await db.query(
    `INSERT INTO tasks (id, title, title_auto, rank) VALUES ($1, $2, false, $3)`,
    [taskId, taskTitle, `zz${tag}`],
  );
  await db.query(
    `INSERT INTO attempts (id, task_id, worktree_path) VALUES ($1, $2, $3)`,
    [attemptId, taskId, `/tmp/${taskId}`],
  );
  for (const [conv, kind] of [
    [user, "user"],
    [system, "system"],
  ] as const) {
    await db.query(
      `INSERT INTO conversations (id, attempt_id, title, status, runtime, model, kind, ended_at)
       VALUES ($1, $2, $3, 'done', 'sdk', $4, $5, now())`,
      [conv.id, attemptId, conv.title, FALLBACK_MODEL, kind],
    );
  }
  return { taskId, taskTitle, attemptId, user, system };
}

/**
 * Rename the task through the app's REAL rename endpoint (`PATCH /api/tasks/:id`),
 * so the write is the one a user's edit makes — `tasks.titleChanged` fires.
 */
export async function renameTask(taskId: string, title: string): Promise<void> {
  const res = await agentFetch(`/api/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) {
    throw new Error(
      `PATCH /api/tasks/${taskId} → ${res.status}: ${await res.text()}`,
    );
  }
}

/** A live frame of `key` (the window or one of its siblings), as the tab received it. */
export function frameOf(key: string): RegExp {
  return new RegExp(`"key":"${key.replace(/\./g, "\\.")}(:[a-z]+)?"`);
}
