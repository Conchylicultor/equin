import type { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import type {
  TaskFilingStart,
  TasksFileGrant,
} from "@plugins/tasks/plugins/tasks-core/core";
import type {
  ModelCatalog,
  ModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  DEFAULT_MODEL_CHOICE,
  assertChoiceLaunchable,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  TASK_TRACKS,
  type TaskTrack,
} from "@plugins/tasks/plugins/task-track/core";
import type { RewireOptions } from "../../server/internal/rewire-dependencies";

export type AddTaskRelation = "followup" | "prerequisite";

export interface AddTaskInput {
  title: string;
  description?: string;
  track: TaskTrack;
  start: TaskFilingStart;
  /** The tasks the new one runs after (`after` / `manual`); absent = the
   * caller's task. An error with `now`. */
  after?: string[];
  /** Single `after` only; absent = `followup`. */
  relation?: AddTaskRelation;
  /** The model an armed task launches with; absent = the grant's model for the
   * track, else the default. An error with `manual`. */
  model?: ModelChoice;
}

/**
 * Everything `add_task` reads and writes, as ports: production binds them to
 * the real mutations (mcp-tools.ts); a test binds them to an in-memory store,
 * with the rewire going through the same `rewireOn` logic over an in-memory
 * graph. The filing POLICY — which edges, which marker, which track — is this
 * file's alone.
 */
export interface AddTaskPorts {
  /** The caller's `tasks.file` grant; `null` = not granted. */
  grant(conversationId: string): Promise<TasksFileGrant | null>;
  getConversation(id: string): Promise<{ taskId: string } | null>;
  getTask(id: string): Promise<{ id: string } | null>;
  createTask(input: Parameters<typeof createTask>[0]): Promise<{ id: string }>;
  inheritLaunchOptions(fromTaskId: string, toTaskId: string): Promise<void>;
  rewire(opts: RewireOptions): Promise<void>;
  /** Plain edges `taskId` → each of `dependsOnIds`, in one batch (a join). */
  addDependencies(taskId: string, dependsOnIds: string[]): Promise<void>;
  armAutoStart(args: {
    taskId: string;
    model: ModelChoice;
    cause: string;
  }): Promise<void>;
  setTrack(taskId: string, track: TaskTrack): Promise<void>;
  /** The live model catalog the `model` choice is checked against. */
  modelCatalog(): ModelCatalog;
}

export interface AddTaskResult {
  task_id: string;
  track: TaskTrack;
  start: TaskFilingStart;
  /** The tasks it runs after (empty for `now`). */
  after: string[];
  /** How a single `after` was wired; null otherwise. */
  relation: AddTaskRelation | null;
  group_id: string;
  /** The armed model, or null — a `manual` task is never armed. */
  model: ModelChoice | null;
}

/** The tracks and start modes a grant allows, as the agent reads them (the
 * tool's live description and every refusal). */
export function describeFilingGrant(grant: TasksFileGrant): string {
  const tracks = TASK_TRACKS.flatMap((track) => {
    const g = grant[track];
    if (!g) return [];
    const model = g.model ? ` (default model ${g.model})` : "";
    return [
      `track "${track}": start ${g.start.map((s) => `"${s}"`).join(" | ")}${model}`,
    ];
  });
  return tracks.length > 0 ? tracks.join("; ") : "no track";
}

/** Refuse, before anything is written, a filing the grant or the parameters
 * forbid. Returns the model to arm (null for `manual`). */
function checkFiling(
  input: AddTaskInput,
  grant: TasksFileGrant | null,
  catalog: ModelCatalog,
): ModelChoice | null {
  if (grant === null)
    throw new Error("Your mandate does not allow filing tasks (`tasks.file`).");
  const trackGrant = grant[input.track];
  if (!trackGrant || !trackGrant.start.includes(input.start)) {
    throw new Error(
      `Your mandate does not allow filing track "${input.track}" with start "${input.start}". ` +
        `It allows: ${describeFilingGrant(grant)}.`,
    );
  }
  if (input.start === "now" && input.after !== undefined)
    throw new Error(
      '`after` is meaningless with start "now" (filed under your task, no dependency): drop it, or use start "after".',
    );
  if (input.start === "now" && input.relation !== undefined)
    throw new Error('`relation` is meaningless with start "now": drop it.');
  if (input.after !== undefined && input.after.length === 0)
    throw new Error(
      "`after` is empty: omit it to run after your task, or name the tasks.",
    );
  if (
    input.relation !== undefined &&
    input.after !== undefined &&
    new Set(input.after).size > 1
  )
    throw new Error(
      "`relation` applies to a single `after` only: several `after` tasks are a join (the new task waits on all of them).",
    );
  if (input.relation === "prerequisite" && input.track !== "main")
    throw new Error(
      'Only a main-track task can be a `prerequisite`: a sidequest would block the main track. File it as a followup, or with track "main" if the current work really must wait for it.',
    );
  if (input.start === "manual") {
    if (input.model !== undefined)
      throw new Error(
        '`model` is meaningless with start "manual": the task is never armed, a person starts it (and picks the model).',
      );
    return null;
  }
  const model = input.model ?? trackGrant.model ?? DEFAULT_MODEL_CHOICE;
  // The tool's schema checks only the id grammar (the catalog is runtime data
  // and an MCP schema is fixed at registration): whether this machine can run
  // the version is checked here, and the refusal lists what can run today.
  assertChoiceLaunchable(model, catalog);
  return model;
}

export async function fileAddTask(
  input: AddTaskInput,
  conversationId: string,
  ports: AddTaskPorts,
): Promise<AddTaskResult> {
  const model = checkFiling(
    input,
    await ports.grant(conversationId),
    ports.modelCatalog(),
  );

  const conv = await ports.getConversation(conversationId);
  if (!conv) throw new Error(`Unknown conversation "${conversationId}"`);
  const currentTaskId = conv.taskId;

  const after =
    input.start === "now" ? [] : [...new Set(input.after ?? [currentTaskId])];
  for (const id of after) {
    if (!(await ports.getTask(id)))
      throw new Error(`\`after\` task "${id}" not found`);
  }

  const task = await ports.createTask({
    // File the new task under the current task's folder (provenance: spawned
    // while working on it). Display-only — the actual ordering comes from the
    // dependency wiring below, not from this folder.
    folderId: currentTaskId,
    groupId: currentTaskId,
    title: input.title,
    // The agent authored this title deliberately — keep it in the launch prompt.
    titleAuto: false,
    description: input.description ?? null,
    author: conversationId,
  });

  // Snapshot the calling task's inheritable launch options (system prompt,
  // thinking mode, …) onto the subtask so it launches configured like the
  // agent that filed it. Names no option — an option added later is inherited
  // here with no edit. Auto-start and the track are deliberately not among
  // them: both are decided per filing.
  await ports.inheritLaunchOptions(currentTaskId, task.id);

  let relation: AddTaskRelation | null = null;
  const [single] = after;
  if (after.length === 1 && single !== undefined) {
    relation = input.relation ?? "followup";
    await ports.rewire(
      input.track === "main"
        ? // Main track: splice into the chain.
          { newTaskId: task.id, targetId: single, relation }
        : // A sidequest runs after its target but is never spliced into its
          // chain: the target's dependents keep waiting on the target (an
          // empty `selectiveInsertBefore` rewires none).
          {
            newTaskId: task.id,
            targetId: single,
            relation: "followup",
            selectiveInsertBefore: [],
          },
    );
  } else if (after.length > 1) {
    // A join: waits on every named task, splices into no chain.
    await ports.addDependencies(task.id, after);
  }

  // No track row for main — absence is main.
  if (input.track !== "main") await ports.setTrack(task.id, input.track);

  if (model !== null) {
    await ports.armAutoStart({
      taskId: task.id,
      model,
      cause: "mcp-add-task",
    });
  }

  return {
    task_id: task.id,
    track: input.track,
    start: input.start,
    after,
    relation,
    group_id: currentTaskId,
    model,
  };
}
