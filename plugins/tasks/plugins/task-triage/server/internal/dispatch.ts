import { interactiveMandate } from "@plugins/tasks/plugins/mandate-presets/core";
import { z } from "zod";
import { getConfig } from "@plugins/config_v2/server";
import { createConversation } from "@plugins/conversations/server";
import {
  assertChoiceLaunchable,
  normalizeModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { assertClaudeCodeReady } from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import { renderPrompt } from "@plugins/tasks/plugins/automations/core";
import { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import { setTaskCategory } from "@plugins/tasks/plugins/task-category/server";
import {
  findSubjectTask,
  setTaskSubject,
  withSubjectLock,
} from "@plugins/tasks/plugins/task-subject/server";
import { MAX_RECENT_COMMITS, taskTriageConfig } from "../../shared/config";
import { TRIAGE_IN_FLIGHT_STATES, type RequestTriageOutcome } from "../../core";
import { TRIAGE_PROFILE_ID, type TriageProfileInput } from "./profile";
import {
  countInState,
  getTriageNote,
  isTriageRunTask,
  markFailed,
  markQueued,
  markRunning,
  oldestQueued,
  readTriagedTask,
  recordLaunch,
  TRIAGE_SUBJECT_KIND,
  type TriagedTask,
} from "./state";
import { tasksTriage } from "./tables";

/** Who launches triage runs (`spawnedBy`, the run task's author). */
export const TRIAGE_AUTHOR = "task-triage";

/** The task category a triage run's own task is filed under. */
const SYSTEM_CATEGORY_ID = "system";

/** "3 days ago", "5 hours ago", "just now" — for the prompt. */
export function ago(then: Date, now: Date): string {
  const hours = Math.floor((now.getTime() - then.getTime()) / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} days ago`;
}

/** The run's first message: the configured prompt, filled for this task. */
async function launchPrompt(
  taskId: string,
  task: TriagedTask,
  mainRoot: string,
  now: Date,
): Promise<string> {
  const [recentCommits, note] = await Promise.all([
    runGit(
      [
        "log",
        "--oneline",
        "--no-decorate",
        `--since=${task.createdAt.toISOString()}`,
        "-n",
        String(MAX_RECENT_COMMITS),
        "refs/heads/main",
      ],
      mainRoot,
    ),
    getTriageNote(taskId),
  ]);
  const description = task.description.trim();
  const prompt = renderPrompt(getConfig(taskTriageConfig).prompt, {
    taskId,
    title: task.title.trim() || "Untitled",
    description:
      description || "(No description — the title is the whole task.)",
    filedAgo: ago(task.createdAt, now),
    recentCommits: recentCommits.trim() || "(none)",
    note: note?.trim() || "(No note.)",
  });
  if (!prompt.ok) {
    throw new Error(
      `task-triage: its prompt uses ${prompt.unknown.map((n) => `{{${n}}}`).join(", ")}, which triage does not fill — fix \`prompt\` in its config`,
    );
  }
  return prompt.text;
}

/**
 * The run's own task — `Triage: <title>` in the System category, about the
 * triaged task (subject `task-triage`) — reused by every later run (each a new
 * attempt of it), created on the first. Never an attempt of the triaged task,
 * which would move it out of `new`.
 */
async function runTaskFor(taskId: string, task: TriagedTask): Promise<string> {
  const subject = { kind: TRIAGE_SUBJECT_KIND, id: taskId };
  return withSubjectLock(subject, async () => {
    const existing = await findSubjectTask(subject);
    if (existing !== null) return existing;
    const created = await createTask({
      title: `Triage: ${task.title.trim() || "Untitled"}`,
      titleAuto: false,
      description: `Read-only triage of task \`${taskId}\`. Its result is the task's Triage card.`,
      author: TRIAGE_AUTHOR,
      // Interactive: the triage profile allowlists exit_clean / flag_raise,
      // and the tool gates still apply on top.
      mandate: interactiveMandate,
    });
    await setTaskCategory(created.id, SYSTEM_CATEGORY_ID);
    await setTaskSubject(created.id, subject);
    return created.id;
  });
}

/**
 * Launch one queued run of `taskId`: mark it running, then start a `system`
 * conversation under its run task in a `tasks.triage` scratch workspace, and
 * record it. A throw anywhere (Claude Code not ready, the model not runnable
 * here, the task gone, a git or launch failure) marks the run failed and
 * rethrows.
 */
async function launchTriageRun(taskId: string): Promise<void> {
  const now = new Date();
  await markRunning(taskId, now);
  try {
    const model = normalizeModelChoice(getConfig(taskTriageConfig).model);
    await assertClaudeCodeReady();
    assertChoiceLaunchable(model, getModelCatalog());
    const task = await readTriagedTask(taskId);
    if (task === null) throw new Error(`task ${taskId} does not exist`);
    const mainRoot = await ensureMainWorktreeRoot();
    const prompt = await launchPrompt(taskId, task, mainRoot, now);
    const runTaskId = await runTaskFor(taskId, task);
    const input: TriageProfileInput = { taskId, mainRoot };
    const conversation = await createConversation({
      taskId: runTaskId,
      kind: "system",
      spawnedBy: TRIAGE_AUTHOR,
      model,
      prompt,
      workspace: { kind: "scratch", profile: TRIAGE_PROFILE_ID, input },
    });
    await recordLaunch(taskId, { conversationId: conversation.id, runTaskId });
  } catch (err) {
    await markFailed(
      taskId,
      `Could not start the triage: ${err instanceof Error ? err.message : String(err)}`,
    );
    throw err;
  }
}

/**
 * Launch queued runs, oldest request first, while fewer than `concurrency`
 * are running. Every launch is attempted; the failures (each already marked
 * on its row) are rethrown together at the end.
 */
async function dispatchQueued(): Promise<void> {
  const { concurrency } = getConfig(taskTriageConfig);
  const free = concurrency - (await countInState("running"));
  const failures: unknown[] = [];
  for (const taskId of await oldestQueued(free)) {
    try {
      await launchTriageRun(taskId);
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `task-triage: ${failures.length} triage runs failed to start`,
    );
  }
}

/**
 * The dispatcher: a singleton, serial job, so two wakes never both count a
 * slot free. Woken on every request, submit, failure and close (push-based);
 * a wake while it runs queues one more run behind it.
 */
export const triageDispatchJob = defineJob({
  name: "task-triage.dispatch",
  description:
    "Starts the queued task triage runs — read-only agents that read a task and rate it — while fewer than the configured number are running, oldest request first.",
  hold: "seconds",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  serial: true,
  maxAttempts: 1,
  run: async () => {
    await dispatchQueued();
  },
});

/** Wake the dispatcher: a slot may have freed, or a run was queued. */
export async function wakeTriageDispatcher(): Promise<void> {
  await triageDispatchJob.enqueue({});
}

/**
 * At boot, wake the dispatcher once — for queued rows no pending wake covers
 * (a worktree's database forked from main's mid-queue). A pending wake already
 * survives a restart (it is a job row), so this is belt and braces.
 */
export const triageDispatchWarmup = defineWarmup({
  name: "task-triage.dispatch",
  description:
    "Starts any task triage runs left queued when the server last stopped.",
  scope: "worktree",
  run: wakeTriageDispatcher,
});

/** What `requestTriage` did, or why it refused. */
export type RequestTriageResult =
  RequestTriageOutcome | { kind: "refused"; reason: "no-task" | "run-task" };

/**
 * Ask for a triage of `taskId`: queue a run and wake the dispatcher. A run in
 * flight is left alone; without `force`, so is a task that has a row already
 * (a read, or a failed run — re-running is the person's call). Refuses a task
 * that does not exist and a triage run's own task (no `Triage: Triage: …`).
 */
export async function requestTriage(
  taskId: string,
  { force }: { force: boolean },
): Promise<RequestTriageResult> {
  if ((await readTriagedTask(taskId)) === null) {
    return { kind: "refused", reason: "no-task" };
  }
  if (await isTriageRunTask(taskId)) {
    return { kind: "refused", reason: "run-task" };
  }
  const row = await tasksTriage.get(taskId);
  if (row !== undefined) {
    const inFlight = (TRIAGE_IN_FLIGHT_STATES as readonly string[]).includes(
      row.state,
    );
    if (inFlight || !force) return { kind: "unchanged", state: row.state };
  }
  await markQueued(taskId, new Date());
  await wakeTriageDispatcher();
  return { kind: "queued" };
}
