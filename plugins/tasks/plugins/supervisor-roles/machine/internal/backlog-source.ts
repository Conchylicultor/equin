import { watchSource } from "@plugins/tasks/plugins/orchestration/plugins/watch/machine";
import type { WatchEventInput } from "@plugins/tasks/plugins/orchestration/plugins/watch/core";
import {
  isInRoleBacklog,
  liveSessionOf,
  supervisorRoleBacklogArrived,
  type SupervisorRoleBacklogArrivedPayload,
} from "../../server";

/**
 * What a role's live session hears of a task entering its backlog: one
 * `backlog` event about the task, routed to the session root's tree watch
 * (`routeTaskId` — a backlog task is a root, in no tree). Read when the
 * ingest runs, so a task already adopted, routed on or launched by then, or a
 * role with no live session, says nothing: the next session reads its
 * backlog itself.
 */
export async function backlogArrivalEvents(
  p: SupervisorRoleBacklogArrivedPayload,
): Promise<WatchEventInput[]> {
  if (!(await isInRoleBacklog(p.taskId, p.roleId))) return [];
  const session = await liveSessionOf(p.roleId);
  if (session === null) return [];
  return [
    {
      kind: "backlog",
      taskId: p.taskId,
      routeTaskId: session.id,
      ...(p.actorConversationId !== null
        ? { actorConversationId: p.actorConversationId }
        : {}),
      summary:
        "new in your role's backlog — adopt_task to take it on, route_task to hand it to another role",
    },
  ];
}

export const backlogArrivalSource = watchSource({
  id: "supervisor-roles.backlog",
  on: supervisorRoleBacklogArrived,
  toEvents: backlogArrivalEvents,
});
