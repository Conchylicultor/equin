import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { IdKinds } from "@plugins/ids/server";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import {
  createSupervisorRole,
  deleteSupervisorRole,
  setTaskSupervisor,
  supervisorRoleIdKind,
  updateSupervisorRole,
  supervisorPromptConfig,
} from "../core";
import { supervisorRoleDefinition } from "./internal/mandate";
import {
  supervisorRoleCapability,
  supervisorRoleReach,
} from "./internal/reach";
import {
  supervisorRolesServed,
  taskSupervisorsServed,
} from "./internal/resources";
import {
  handleCreateSupervisorRole,
  handleDeleteSupervisorRole,
  handleSetTaskSupervisor,
  handleUpdateSupervisorRole,
} from "./internal/routes";
import "./internal/saved-icons";
import {
  supervisorPromptSection,
  supervisorRolesSection,
} from "./internal/sections";
import { tasksSupervisor } from "./internal/tables";
import { supervisorRoleIconStale } from "./internal/tables-events";

export {
  FALLBACK_ROLE_REF,
  fileToBacklog,
  getSupervisorRole,
  isSessionRoot,
  liveSessionOf,
  resolveFilingRole,
  roleBacklog,
  roleOfConversation,
  setTaskSupervisorRole,
  supervisorOfTask,
} from "./internal/roles";
export type { BacklogFiling, RoleTaskRow } from "./internal/roles";
export { BACKLOG_READ_LIMIT } from "./internal/roles";
export { _supervisorRoles, tasksSupervisor } from "./internal/tables";
export { supervisorRoleIconStale } from "./internal/tables-events";
export type { SupervisorRoleIconStalePayload } from "./internal/tables-events";

export default {
  description:
    "Supervisor roles, data half: the supervisor_roles table (name, Haiku-picked icon with a person's override, listed, description, prompt, the one fallback) served whole as supervisor-roles.all with its create / edit / delete endpoints; the per-task owner (tasks_ext_supervisor, a role id, exposed as the `supervisor` field of every task list, routed by PUT /api/tasks/:taskId/supervisor); filing into a role's backlog (fileToBacklog — a root task owned by the role, never armed); the supervisor-role mandate (the supervisor preset plus the role powers on the root) and its reach (a role session manages every task its role owns); the system-prompt sections listing the listed roles to agents that may file into a backlog, and the shared supervisor prompt (a config) for every supervisor root.",
  httpRoutes: {
    [createSupervisorRole.route]: handleCreateSupervisorRole,
    [updateSupervisorRole.route]: handleUpdateSupervisorRole,
    [deleteSupervisorRole.route]: handleDeleteSupervisorRole,
    [setTaskSupervisor.route]: handleSetTaskSupervisor,
  },
  contributions: [
    IdKinds.Kind({ kind: supervisorRoleIdKind }),
    ConfigV2.Register({ descriptor: supervisorPromptConfig }),
    ...supervisorRolesServed.declare,
    ...taskSupervisorsServed.declare,
    LiveColumns.Expose(tasksSupervisor),
    supervisorRoleDefinition,
    supervisorRoleCapability,
    supervisorRoleReach,
    supervisorRolesSection,
    supervisorPromptSection,
  ],
  register: [supervisorRoleIconStale],
} satisfies ServerPluginDefinition;
