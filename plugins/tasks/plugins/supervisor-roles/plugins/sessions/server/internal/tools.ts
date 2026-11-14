import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import {
  DEFAULT_MODEL_CHOICE,
  ModelChoiceSchema,
} from "@plugins/conversations/plugins/model-provider/core";
import { tasksFile } from "@plugins/tasks/plugins/tasks-core/core";
import { getTaskTrack } from "@plugins/tasks/plugins/task-track/server";
import {
  granted,
  grantOf,
} from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { watchTask } from "@plugins/tasks/plugins/orchestration/plugins/watch/server";
import { watchChildren } from "@plugins/tasks/plugins/orchestration/plugins/watch/plugins/capabilities/core";
import { supervisorRole } from "@plugins/tasks/plugins/supervisor-roles/core";
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
} from "@plugins/tasks/plugins/supervisor-roles/server";
import { formatBacklog, type BacklogLine } from "../../core";
import { adoptIntoSession } from "./adopt";

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
    const lines = await Promise.all(
      rows.map(async (r): Promise<BacklogLine> => ({
        taskId: r.id,
        track: await getTaskTrack(r.id),
        status: r.status === "new" ? null : r.status,
        title: r.title,
        filedFrom: r.filedFromTaskId ?? null,
      })),
    );
    return text(formatBacklog(lines, BACKLOG_READ_LIMIT));
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
    const adopted = await adoptIntoSession({
      taskId,
      roleId,
      rootTaskId,
      model,
      beforeArm: async () => {
        if ((await grantOf(watchChildren, conversationId)) !== null)
          await watchTask(taskId, { kind: "conversation", conversationId });
      },
    });
    if (!adopted.ok)
      return text(
        adopted.refusal === "held"
          ? `${taskId} is held by a person: it stays in the backlog.`
          : `${taskId} is not in your role's backlog (\`backlog\` lists what is).`,
      );
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
