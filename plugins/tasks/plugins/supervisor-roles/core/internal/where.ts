import {
  exposedColumns,
  type LiveWhereOf,
} from "@plugins/network/plugins/live/core";
import {
  taskMandateShape,
  type taskWindow,
  type TaskStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import { supervisorRoleMandate } from "./mandate";
import { taskSupervisorShape } from "./supervisor-field";

const supervisorColumns = exposedColumns(taskSupervisorShape.exposure);
const mandateColumns = exposedColumns(taskMandateShape.exposure);

/** A `taskWindow` where over the supervisor and mandate column sets, declared
 * so tsc checks its columns where it is written. */
type RoleWhere = LiveWhereOf<
  typeof taskWindow,
  [typeof supervisorColumns, typeof mandateColumns]
>;

// How a role's backlog and its sessions read off the task tree (tasks-core's
// `taskWindow`, `tasks.tree.v2`) — the ONE definition, read by the server
// (the backlog tool, the one-live-session rule) and the Supervisors pane
// alike. Every field named is a task field or an exposed one
// (`tasks_ext_supervisor.supervisor`, `tasks_ext_mandate.mandateId`).

/**
 * A backlog task waits to be adopted: `new`, `held` by a person, or
 * `blocked` on a prerequisite someone wired to it. A task an agent ran
 * leaves the backlog (`attempted` / `done`), as does a dropped one.
 */
export const BACKLOG_STATUSES = [
  "new",
  "blocked",
  "held",
] as const satisfies readonly TaskStatus[];

/**
 * A role session is live until its root's agent ended (`attempted`: closed,
 * or hibernated — a resumable conversation that no longer runs) or its work
 * landed (`done`) or it was dropped. A just-launched session (`new`, armed)
 * is live: a second launch would race it for the backlog.
 */
export const ENDED_SESSION_STATUSES = [
  "attempted",
  "done",
  "dropped",
] as const satisfies readonly TaskStatus[];

/**
 * The backlog of role `roleId`: root tasks it owns that are not its session
 * roots and have not run. (A backlog root states the interactive mandate —
 * every root names one — so a person can still launch it by hand.)
 */
export function roleBacklogWhere(roleId: string): RoleWhere {
  return {
    "tasks_ext_supervisor.supervisor": roleId,
    folderId: { isEmpty: true },
    "tasks_ext_mandate.mandateId": { ne: supervisorRoleMandate.id },
    status: { in: [...BACKLOG_STATUSES] },
  };
}

/** Every session of role `roleId` (live or ended): its session roots. */
export function roleSessionsWhere(roleId: string): RoleWhere {
  return {
    "tasks_ext_supervisor.supervisor": roleId,
    folderId: { isEmpty: true },
    "tasks_ext_mandate.mandateId": supervisorRoleMandate.id,
  };
}

/** Whether a session root's status means the session is still live. */
export function isLiveSessionStatus(status: TaskStatus): boolean {
  return !(ENDED_SESSION_STATUSES as readonly TaskStatus[]).includes(status);
}
