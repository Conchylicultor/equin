import { z } from "zod";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { withNotifyBatch } from "@plugins/framework/plugins/server-core/core";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import {
  assertChoiceLaunchable,
  DEFAULT_MODEL_CHOICE,
  ModelChoiceSchema,
} from "@plugins/conversations/plugins/model-provider/core";
import { getModelCatalog } from "@plugins/conversations/plugins/model-provider/plugins/catalog/server";
import {
  _tasks,
  clearMandate,
  tasksView,
  updateTask,
  withTaskStatusBatch,
} from "@plugins/tasks/plugins/tasks-core/server";
import { tasksFile } from "@plugins/tasks/plugins/tasks-core/core";
import { getTaskTrack } from "@plugins/tasks/plugins/task-track/server";
import {
  granted,
  grantOf,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { watchTask } from "@plugins/tasks/plugins/orchestration/plugins/watch/server";
import { watchChildren } from "@plugins/tasks/plugins/orchestration/plugins/watch/plugins/capabilities/core";
import { armTaskAutoStart } from "@plugins/tasks/server";
import {
  BACKLOG_STATUSES,
  supervisorRole,
  supervisorRoleMandate,
} from "@plugins/tasks/plugins/supervisor-roles/core";
import {
  BACKLOG_READ_LIMIT,
  FALLBACK_ROLE_REF,
  getSupervisorRole,
  isSessionRoot,
  resolveFilingRole,
  roleBacklog,
  roleOfConversation,
  setTaskSupervisorRole,
  supervisorOfTask,
  tasksSupervisor,
} from "@plugins/tasks/plugins/supervisor-roles/server";

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

/** The caller's role and session root; throws for a conversation of none
 * (the tools are gated on the role powers, which only a role root has). */
async function callerRole(conversationId: string) {
  const role = await roleOfConversation(conversationId);
  if (role === null)
    throw new Error("This conversation is not a supervisor role's session.");
  return role;
}

export const backlogTool = Mcp.tool({
  name: "backlog",
  when: granted(supervisorRole),
  description: `List your supervisor role's backlog: the tasks filed to the role (by agents, or routed to it) that no session has adopted yet, oldest first — id, track, title, and the task whose agent filed it. Adopt one into your session with \`adopt_task\`, hand it to another role with \`route_task\`, or drop it with \`drop_task\`.`,
  inputSchema: {},
  async handler(_input, { conversationId }) {
    const { roleId } = await callerRole(conversationId);
    const rows = await roleBacklog(roleId);
    if (rows.length === 0) return text("The backlog is empty.");
    const lines = await Promise.all(
      rows.map(async (r) => {
        const track = await getTaskTrack(r.id);
        const from = r.filedFromTaskId
          ? ` (filed from ${r.filedFromTaskId})`
          : "";
        const held = r.status === "new" ? "" : ` [${r.status}]`;
        return `- ${r.id} [${track}]${held} ${r.title}${from}`;
      }),
    );
    const more =
      rows.length === BACKLOG_READ_LIMIT
        ? ` — the oldest ${BACKLOG_READ_LIMIT}; adopt, route or drop some to see the rest`
        : "";
    return text(`Backlog (${rows.length}${more}):\n${lines.join("\n")}`);
  },
});

export const adoptTaskTool = Mcp.tool({
  name: "adopt_task",
  when: granted(supervisorRole),
  description: `Adopt a task from your role's backlog into this session: it moves under your session's root task (your tree — you watch it, as a task you filed) and is armed, so an agent launches on it once nothing it runs after is pending. Only a task of your own role's backlog (\`backlog\` lists them) that is not held.`,
  inputSchema: {
    task_id: z.string().min(1).describe("The backlog task to adopt."),
    model: ModelChoiceSchema.optional().describe(
      "The model its agent launches with; absent = your filing default for its track.",
    ),
  },
  async handler(input, { conversationId }) {
    const { roleId, rootTaskId } = await callerRole(conversationId);
    const taskId = input.task_id.trim();
    const track = await getTaskTrack(taskId);
    const grant = await grantOf(tasksFile, conversationId);
    const model = input.model ?? grant?.[track]?.model ?? DEFAULT_MODEL_CHOICE;
    assertChoiceLaunchable(model, getModelCatalog());
    // One transaction, the task row locked first so a concurrent launch,
    // hold or route is seen: still in the backlog → it joins the tree,
    // inherits the session's mandate (its own — the interactive one every
    // root states — dropped, or it would stay a root of its own), and its
    // owner row goes (the tree's root carries the role from now on).
    const refusal = await withNotifyBatch(() =>
      withTaskStatusBatch(async (tx) => {
        await tx.execute(
          sql`SELECT 1 FROM ${_tasks} WHERE ${_tasks.id} = ${taskId} FOR UPDATE`,
        );
        const [row] = await tx
          .select({ status: tasksView.status })
          .from(tasksView)
          .innerJoin(_tasks, eq(_tasks.id, tasksView.id))
          .innerJoin(
            tasksSupervisor.table,
            eq(tasksSupervisor.table.taskId, tasksView.id),
          )
          .where(
            and(
              eq(tasksView.id, taskId),
              eq(tasksSupervisor.table.supervisor, roleId),
              isNull(tasksView.folderId),
              ne(_tasks.mandateRef, supervisorRoleMandate.id),
              inArray(tasksView.status, [...BACKLOG_STATUSES]),
            ),
          )
          .limit(1);
        if (!row)
          return `${taskId} is not in your role's backlog (\`backlog\` lists what is).`;
        if (row.status === "held")
          return `${taskId} is held by a person: it stays in the backlog.`;
        await updateTask(taskId, { folderId: rootTaskId }, tx);
        await clearMandate(taskId, tx);
        await tasksSupervisor.delete(taskId, tx);
        return null;
      }),
    );
    if (refusal !== null) return text(refusal);
    if ((await grantOf(watchChildren, conversationId)) !== null)
      await watchTask(taskId, { kind: "conversation", conversationId });
    await armTaskAutoStart({
      taskId,
      model,
      armedFrom: asPluginId("tasks.supervisor-roles.sessions"),
    });
    return text(
      `Adopted ${taskId} into your session (under ${rootTaskId}), armed with ${model}.`,
    );
  },
});

export const routeTaskTool = Mcp.tool({
  name: "route_task",
  when: granted(supervisorRole),
  description: `Hand a task of your role's backlog to another supervisor role: it moves to that role's backlog. \`supervisor\` is a role id, or "${FALLBACK_ROLE_REF}" for the fallback role. Only a backlog task of your own role — a session's root keeps its role, and an adopted task belongs to your session's tree.`,
  inputSchema: {
    task_id: z.string().min(1).describe("The task to route."),
    supervisor: z
      .string()
      .min(1)
      .describe(
        `The role that owns it from now on, or "${FALLBACK_ROLE_REF}".`,
      ),
  },
  async handler(input, { conversationId }) {
    const { roleId, rootTaskId } = await callerRole(conversationId);
    const taskId = input.task_id.trim();
    if (taskId === rootTaskId || (await isSessionRoot(taskId)))
      return text(`${taskId} is a session's root: it keeps its role.`);
    if ((await supervisorOfTask(taskId)) !== roleId)
      return text(`${taskId} is not in your role's backlog.`);
    let target: string;
    if (input.supervisor === FALLBACK_ROLE_REF) {
      target = (await resolveFilingRole(FALLBACK_ROLE_REF)).id;
    } else {
      const role = await getSupervisorRole(input.supervisor);
      if (!role) return text(`No supervisor role "${input.supervisor}".`);
      target = role.id;
    }
    await setTaskSupervisorRole(taskId, target);
    return text(`Routed ${taskId} to ${target}.`);
  },
});
