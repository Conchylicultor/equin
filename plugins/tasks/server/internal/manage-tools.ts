import { z } from "zod";
import { db } from "@plugins/database/server";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { withNotifyBatch } from "@plugins/framework/plugins/server-core/core";
import { extractAttachmentIds } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/core";
import {
  DEFAULT_MODEL_CHOICE,
  ModelChoiceSchema,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import { setTaskAutoStart } from "@plugins/tasks/plugins/auto-start/server";
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
import {
  dropTask,
  EDIT_STARTS,
  editTask,
  renderManageOutcome,
  type ManageTasksPorts,
} from "./manage-tasks";

// The real reads and writes behind `edit_task` / `drop_task`. The scope
// policy lives in manage-tasks.ts, which a test drives over an in-memory store.
const ports: ManageTasksPorts = {
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
    // As the Launch button's arm: an attempt not yet finished with already IS
    // the task's launch, so the queue would claim the marker and skip it.
    const attempts = await listAttemptsForTask(taskId);
    if (attempts.some((a) => a.retained))
      return `${taskId} already has an open attempt — message its agent with \`message_agent\` instead.`;
    return null;
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
        }),
      );
    } catch (err) {
      if (err instanceof DependencyCycleError)
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
        cause: "mcp-edit-task",
      });
    else if (edit.start?.kind === "manual")
      await setTaskAutoStart(edit.taskId, null);
    return { ok: true };
  },
  async drop(taskId) {
    await updateTask(taskId, { drop: true });
  },
};

const SCOPE = `Only the tasks of your own task tree (those under your mandate's root, as \`task_tree\` lists them) — never a task elsewhere, nor your tree's root (your own task) itself; anything else is refused.`;

export const editTaskTool = Mcp.tool({
  name: "edit_task",
  // Only an agent whose mandate lets it manage its tree sees the tool.
  when: granted(tasksManage),
  description: `Edit a task of your tree: its title, its description (the problem it states — the prompt its agent launches with), the tasks it runs after, its track, and how it starts.

\`start: "armed"\` queues it to launch on its own once every task it runs after is done (at once when none is pending) — on any track: a sidequest is never armed when filed, but you may start it here. \`start: "manual"\` disarms it: a person starts it. Arming a dropped task, or one whose agent already launched and is still open, is refused.

Arming does not change the track: when you turn a sidequest into work on the critical path, also pass \`track: "main"\` (and \`track: "sidequest"\` for the reverse).

${SCOPE} Every id named (the task and each \`add_after\` / \`remove_after\` id) must be in your tree — the root may be an \`add_after\` / \`remove_after\` id (\`remove_after: [<your task>]\` frees a task wired to wait on yours); a refused edit (or one closing a dependency cycle) changes nothing.

Editing a task whose agent already launched does not reach that agent — message it with \`message_agent\`.`,
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
  },
  async handler(input, { conversationId }) {
    const out = await editTask(input, conversationId, ports);
    return { content: [{ type: "text", text: renderManageOutcome(out) }] };
  },
});

export const dropTaskTool = Mcp.tool({
  name: "drop_task",
  when: granted(tasksManage),
  description: `Drop a task of your tree — it will not run (its dependents stop waiting on it), as the Drop button does. A person can restore it.

${SCOPE}`,
  inputSchema: {
    task_id: z.string().min(1).describe("The task to drop."),
  },
  async handler(input, { conversationId }) {
    const out = await dropTask(input, conversationId, ports);
    return { content: [{ type: "text", text: renderManageOutcome(out) }] };
  },
});

/** How a `tasks.manage` grant reads to the agent. */
export const tasksManageCapability = Mandate.Capability({
  cap: tasksManage,
  describe: () =>
    "You may edit (title, description, dependencies, track, how it starts — arm or disarm it, sidequests included) and drop the tasks of this tree with `edit_task` and `drop_task` — only the tasks below its root, never a task outside it.",
});
