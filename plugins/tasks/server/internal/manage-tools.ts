import { z } from "zod";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { db } from "@plugins/database/server";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { withNotifyBatch } from "@plugins/framework/plugins/server-core/core";
import { extractAttachmentIds } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/core";
import {
  DEFAULT_MODEL_CHOICE,
  ModelChoiceSchema,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import {
  disarmTaskAutoStart,
  setTaskAutoStart,
} from "@plugins/tasks/plugins/auto-start/server";
import { handOffToBacklog } from "@plugins/tasks/plugins/supervisor-roles/server";
import {
  getTaskTrack,
  setTaskTrack,
} from "@plugins/tasks/plugins/task-track/server";
import { TASK_TRACKS } from "@plugins/tasks/plugins/task-track/core";
import {
  addTaskDependency,
  DependencyCycleError,
  getConversation,
  getTask,
  listAttemptsForTask,
  nearestMandate,
  removeTaskDependency,
  taskAttachments,
  updateTask,
  withTaskStatusBatch,
} from "@plugins/tasks/plugins/tasks-core/server";
import { tasksFile, tasksManage } from "@plugins/tasks/plugins/tasks-core/core";
import {
  granted,
  grantOf,
  Mandate,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { armTaskAutoStart } from "./arm-auto-start";
import { actsAsOwner, describeOwner, taskOwnership } from "./task-ownership";
import {
  dropTask,
  EDIT_STARTS,
  editTask,
  renderManageOutcome,
  type ManageTasksPorts,
} from "./manage-tasks";

/** A hand-off the backlog refused, thrown inside the edit's transaction so the
 * whole edit rolls back, and answered as a refusal. */
class HandOffRefused extends Error {}

// The real reads and writes behind `edit_task` / `drop_task`. The scope
// policy lives in manage-tasks.ts, which a test drives over an in-memory store.
const ports: ManageTasksPorts = {
  async callerTask(conversationId) {
    return (await getConversation(conversationId))?.taskId ?? null;
  },
  async ownerOf(conversationId, taskId) {
    const owner = await taskOwnership(taskId);
    if (owner === null) return { kind: "not-found" };
    return (await actsAsOwner(conversationId, owner))
      ? { kind: "owned" }
      : { kind: "not-owned", owner: describeOwner(owner) };
  },
  canManage: async (conversationId) =>
    (await grantOf(tasksManage, conversationId)) !== null,
  canHandOff: async (conversationId) =>
    (await grantOf(tasksFile, conversationId))?.backlog === true,
  async callerRoot(conversationId) {
    const conversation = await getConversation(conversationId);
    if (!conversation?.taskId) return null;
    const nearest = await nearestMandate(conversation.taskId, db);
    return nearest.kind === "found" ? nearest.rootTaskId : null;
  },
  async rootOf(taskId) {
    if ((await getTask(taskId)) === null) return { kind: "not-found" };
    const nearest = await nearestMandate(taskId, db);
    return nearest.kind === "found"
      ? { kind: "found", rootTaskId: nearest.rootTaskId }
      : { kind: "none" };
  },
  async unarmable(taskId) {
    const task = await getTask(taskId);
    if (task?.droppedAt) return `${taskId} is dropped — it will not run.`;
    return null;
  },
  async launched(taskId) {
    // As the Launch button's arm: an attempt not yet finished with already IS
    // the task's launch.
    const attempts = await listAttemptsForTask(taskId);
    return attempts.some((a) => a.retained);
  },
  trackOf: getTaskTrack,
  async defaultModel(conversationId, track) {
    // The model the caller's filing grant gives the track, as add_task arms
    // with — else the default.
    const grant = await grantOf(tasksFile, conversationId);
    return grant?.[track]?.model ?? DEFAULT_MODEL_CHOICE;
  },
  modelCatalog: getModelCatalog,
  async apply(edit) {
    try {
      // One transaction: a cycle on the last edge rolls back the whole edit.
      await withNotifyBatch(() =>
        withTaskStatusBatch(async (tx) => {
          await updateTask(
            edit.taskId,
            {
              ...(edit.title !== undefined ? { title: edit.title } : {}),
              ...(edit.description !== undefined
                ? { description: edit.description }
                : {}),
            },
            tx,
          );
          for (const id of edit.removeAfter)
            await removeTaskDependency(edit.taskId, id, tx);
          for (const id of edit.addAfter)
            await addTaskDependency(edit.taskId, id, tx);
          if (edit.track !== undefined)
            await setTaskTrack(edit.taskId, edit.track, tx);
          if (edit.handOff !== undefined) {
            // Disarmed first, on the same transaction: the hand-off drops the
            // task's dependencies, and an armed task with none would launch.
            await disarmTaskAutoStart(edit.taskId, tx);
            const out = await handOffToBacklog(
              { taskId: edit.taskId, ...edit.handOff },
              tx,
            );
            if (!out.ok) throw new HandOffRefused(out.message);
          }
        }),
      );
    } catch (err) {
      if (err instanceof DependencyCycleError || err instanceof HandOffRefused)
        return { ok: false, message: err.message };
      throw err;
    }
    // Same reconcile as the PATCH route: the description is the text column
    // that carries attachment refs.
    if (edit.description !== undefined) {
      await taskAttachments.set(
        edit.taskId,
        edit.description ? extractAttachmentIds(edit.description) : [],
      );
    }
    // Last, so a launch it wakes sees the dependencies just written.
    if (edit.start?.kind === "armed")
      await armTaskAutoStart({
        taskId: edit.taskId,
        model: edit.start.model,
        armedFrom: asPluginId("tasks"),
      });
    else if (edit.start?.kind === "manual")
      await setTaskAutoStart(edit.taskId, null);
    return { ok: true };
  },
  async drop(taskId) {
    await updateTask(taskId, { drop: true });
  },
};

const SCOPE = `Only the tasks you OWN: the tasks you filed (\`add_task\`, from this task's conversations) — or, as a supervisor, every task of your tree, plus your role's backlog and earlier sessions. Never a task a person or another agent filed, nor your own task itself; anything else is refused, naming its owner. A task you handed to a supervisor is the supervisor's.`;

const EXIT = `**Before you exit**, every sidequest you filed that is still waiting must be resolved — \`exit_clean\` is refused until it is: drop it (\`drop_task\`) when it is not worth doing — ask yourself what it actually gains — or hand it to a supervisor (\`edit_task\` with \`supervisor\`), adding what you learned since filing it.`;

/** Whoever may file tasks manages what it filed; a supervisor (`tasks.manage`)
 * its tree. */
const canFileOrManage = async (ctx: { conversationId: string }) =>
  (await granted(tasksFile)(ctx)) || (await granted(tasksManage)(ctx));

export const editTaskTool = Mcp.tool({
  name: "edit_task",
  when: canFileOrManage,
  description: `Edit a task you own: its title, its description (the problem it states — the prompt its agent launches with), the tasks it runs after, who owns it — and, as a supervisor, its track and how it starts.

\`supervisor: "<role id>"\` hands the task to a listed supervisor role's backlog (your system prompt's Supervisor roles): it leaves your tree for the backlog — depending on nothing, never armed — and is the role's from then on. Pass a new \`description\` in the same call to give the role what you learned since filing it. Refused for a task that already ran, or that other tasks run after.

\`start\` and \`track\` are a supervisor's (granted \`tasks.manage\`); anyone else is refused. \`start: "armed"\` queues it to launch on its own once every task it runs after is done (at once when none is pending) — on any track, but only a task of your own tree. \`start: "manual"\` disarms it: a person starts it. Arming a dropped task, or one whose agent already launched and is still open, is refused. Arming does not change the track: when you turn a sidequest into work on the critical path, also pass \`track: "main"\` (and \`track: "sidequest"\` for the reverse).

${SCOPE} Every id named (the task and each \`add_after\` / \`remove_after\` id) must be yours — your own task may be an \`add_after\` / \`remove_after\` id (\`remove_after: [<your task>]\` frees a task wired to wait on yours); a refused edit (or one closing a dependency cycle) changes nothing.

${EXIT}

Editing a task whose agent already launched does not reach that agent — message it with \`message_agent\`. \`add_after\` on such a task is refused: a dependency cannot hold back a launch that already happened.`,
  inputSchema: {
    task_id: z.string().min(1).describe("The task to edit."),
    title: z.string().min(1).optional().describe("The new title."),
    description: z
      .string()
      .nullable()
      .optional()
      .describe("The new description (replaces it whole); null clears it."),
    add_after: z
      .array(z.string().min(1))
      .optional()
      .describe("Task ids it should run after (dependencies to add)."),
    remove_after: z
      .array(z.string().min(1))
      .optional()
      .describe(
        "Task ids it should no longer run after (dependencies to remove).",
      ),
    start: z
      .enum(EDIT_STARTS)
      .optional()
      .describe(
        '"armed": launch on its own once nothing it runs after is pending. "manual": disarm — a person starts it.',
      ),
    model: ModelChoiceSchema.optional().describe(
      'The model an armed task launches with (only with start "armed"); absent = your filing default for its track (the new one, with `track`).',
    ),
    track: z
      .enum(TASK_TRACKS)
      .optional()
      .describe(
        '"main": on the critical path. "sidequest": off it. Absent = unchanged.',
      ),
    supervisor: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Hand the task to this listed supervisor role's backlog (a role id from your system prompt's Supervisor roles). No `start: \"armed\"` / `add_after` with it.",
      ),
  },
  async handler(input, { conversationId }) {
    const out = await editTask(input, conversationId, ports);
    return { content: [{ type: "text", text: renderManageOutcome(out) }] };
  },
});

export const dropTaskTool = Mcp.tool({
  name: "drop_task",
  when: canFileOrManage,
  description: `Drop a task you own — it will not run (its dependents stop waiting on it), as the Drop button does. A person can restore it.

${SCOPE}

${EXIT}`,
  inputSchema: {
    task_id: z.string().min(1).describe("The task to drop."),
  },
  async handler(input, { conversationId }) {
    const out = await dropTask(input, conversationId, ports);
    return { content: [{ type: "text", text: renderManageOutcome(out) }] };
  },
});

/** A `tasks.manage` grant adds no Mandate line: `edit_task` / `drop_task`
 * state what it adds (start and track) in their descriptions. */
export const tasksManageCapability = Mandate.Capability({
  cap: tasksManage,
  describe: () => null,
});
