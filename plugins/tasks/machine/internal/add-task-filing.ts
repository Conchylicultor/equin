import type { createTask } from "@plugins/tasks/plugins/tasks-core/server";
import type {
  ModelCatalog,
  ModelChoice,
} from "@plugins/conversations/plugins/model-provider/core";
import {
  DEFAULT_MODEL_CHOICE,
  assertChoiceLaunchable,
} from "@plugins/conversations/plugins/model-provider/core";
import type { TaskTrack } from "@plugins/tasks/plugins/task-track/core";
import type { RewireOptions } from "../../server/internal/rewire-dependencies";

export interface AddTaskInput {
  title: string;
  description?: string;
  relation: "followup" | "prerequisite";
  target?: string;
  track: TaskTrack;
  /** Main track only; absent = the default model. A sidequest refuses it. */
  autostart?: ModelChoice;
}

/**
 * Everything `add_task` reads and writes, as ports: production binds them to
 * the real mutations (mcp-tools.ts); a test binds them to an in-memory store,
 * with the rewire going through the same `rewireOn` logic over an in-memory
 * graph. The filing POLICY — which edges, which marker, which track — is this
 * file's alone.
 */
export interface AddTaskPorts {
  getConversation(id: string): Promise<{ taskId: string } | null>;
  getTask(id: string): Promise<{ id: string } | null>;
  createTask(input: Parameters<typeof createTask>[0]): Promise<{ id: string }>;
  inheritLaunchOptions(fromTaskId: string, toTaskId: string): Promise<void>;
  rewire(opts: RewireOptions): Promise<void>;
  armAutoStart(args: {
    taskId: string;
    model: ModelChoice;
    cause: string;
  }): Promise<void>;
  setTrack(taskId: string, track: TaskTrack): Promise<void>;
  /** The live model catalog the `autostart` choice is checked against. */
  modelCatalog(): ModelCatalog;
}

export interface AddTaskResult {
  task_id: string;
  relation: AddTaskInput["relation"];
  track: TaskTrack;
  group_id: string;
  /** The armed model, or null — a sidequest is never armed by an agent. */
  autostart: ModelChoice | null;
}

/**
 * Refuse a filing the tracks forbid, before anything is written:
 * - a sidequest with `autostart` — sidequests are never auto-started by an
 *   agent; a human arms one from the task detail.
 * - a sidequest as a `prerequisite` — it would block the main track on a
 *   sidequest.
 */
export function assertTrackAllows(input: AddTaskInput): void {
  if (input.track !== "sidequest") return;
  if (input.autostart !== undefined) {
    throw new Error(
      "A sidequest cannot be filed with `autostart`: sidequests are never auto-started by an agent " +
        '(a human arms one from the task detail). Drop `autostart`, or file it with track "main" ' +
        "if it really is on the critical path of the feature.",
    );
  }
  if (input.relation === "prerequisite") {
    throw new Error(
      "A sidequest cannot be a `prerequisite`: it would block the main track on a sidequest. " +
        'File it as a followup sidequest, or with track "main" if the current work really must wait for it.',
    );
  }
}

export async function fileAddTask(
  input: AddTaskInput,
  conversationId: string,
  ports: AddTaskPorts,
): Promise<AddTaskResult> {
  assertTrackAllows(input);
  // The tool's schema checks only the id grammar (the catalog is runtime data
  // and an MCP schema is fixed at registration): whether this machine can run
  // the version is checked here, before anything is written, and the refusal
  // lists the choices that can run today.
  if (input.autostart !== undefined)
    assertChoiceLaunchable(input.autostart, ports.modelCatalog());

  const conv = await ports.getConversation(conversationId);
  if (!conv) throw new Error(`Unknown conversation "${conversationId}"`);
  const currentTaskId = conv.taskId;

  const targetId = input.target ?? currentTaskId;
  const targetTask = await ports.getTask(targetId);
  if (!targetTask) throw new Error(`Target task "${targetId}" not found`);

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
  // them: both are decided per filing, below.
  await ports.inheritLaunchOptions(currentTaskId, task.id);

  if (input.track === "sidequest") {
    // Runs after the target, but is never spliced into its chain: the
    // target's existing dependents keep waiting on the target, not on this
    // sidequest (an empty `selectiveInsertBefore` rewires none).
    await ports.rewire({
      newTaskId: task.id,
      targetId,
      relation: "followup",
      selectiveInsertBefore: [],
    });
    await ports.setTrack(task.id, "sidequest");
    return {
      task_id: task.id,
      relation: "followup",
      track: "sidequest",
      group_id: currentTaskId,
      autostart: null,
    };
  }

  // Main track: splice into the chain and arm, as every filing did before
  // tracks existed. No track row — absence is main.
  await ports.rewire({
    newTaskId: task.id,
    targetId,
    relation: input.relation,
  });
  const model = input.autostart ?? DEFAULT_MODEL_CHOICE;
  await ports.armAutoStart({
    taskId: task.id,
    model,
    cause: "mcp-add-task",
  });
  return {
    task_id: task.id,
    relation: input.relation,
    track: "main",
    group_id: currentTaskId,
    autostart: model,
  };
}
