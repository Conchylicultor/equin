import { z } from "zod";
import { db } from "@plugins/database/server";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { withNotifyBatch } from "@plugins/framework/plugins/server-core/core";
import { extractAttachmentIds } from "@plugins/primitives/plugins/text-editor/plugins/paste-images/core";
import {
  addTaskDependency,
  DependencyCycleError,
  getConversation,
  getTask,
  nearestMandate,
  removeTaskDependency,
  taskAttachments,
  updateTask,
  withTaskStatusBatch,
} from "@plugins/tasks/plugins/tasks-core/server";
import { tasksManage } from "@plugins/tasks/plugins/tasks-core/core";
import {
  granted,
  Mandate,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import {
  dropTask,
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
    return { ok: true };
  },
  async drop(taskId) {
    await updateTask(taskId, { drop: true });
  },
};

const SCOPE = `Only the tasks of your own task tree (those under your mandate's root, as \`task_tree\` lists them) — never a task elsewhere, nor your tree's root (your own task); anything else is refused.`;

export const editTaskTool = Mcp.tool({
  name: "edit_task",
  // Only an agent whose mandate lets it manage its tree sees the tool.
  when: granted(tasksManage),
  description: `Edit a task of your tree: its title, its description (the problem it states — the prompt its agent launches with), and the tasks it runs after.

${SCOPE} Every id named (the task and each \`add_after\` / \`remove_after\` id) must be in your tree; a refused edit (or one closing a dependency cycle) changes nothing.

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
    "You may edit (title, description, dependencies) and drop the tasks of this tree with `edit_task` and `drop_task` — only the tasks below its root, never a task outside it.",
});
