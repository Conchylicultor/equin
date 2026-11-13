import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { adoptBacklogTask, launchRoleSession } from "../core";
import {
  handleAdoptBacklogTask,
  handleLaunchRoleSession,
} from "./internal/launch";
import { adoptTaskTool, backlogTool, routeTaskTool } from "./internal/tools";

export default {
  description:
    "Supervisor role sessions: POST /api/supervisor-roles/:id/sessions opens the role's live session or launches one (one live session per role — a root task stating the supervisor-role mandate, owned by the role, its brief the role's prompt, armed at once), POST …/:id/backlog/:taskId/adopt (the Supervisors pane's Adopt: into the live session, launching one when none is live), and the role powers' MCP tools, gated on the role capability: backlog (list the role's backlog), adopt_task (move a backlog task under the live session's root and arm it) and route_task (hand a task the role owns to another role).",
  httpRoutes: {
    [launchRoleSession.route]: handleLaunchRoleSession,
    [adoptBacklogTask.route]: handleAdoptBacklogTask,
  },
  register: [backlogTool, adoptTaskTool, routeTaskTool],
} satisfies ServerPluginDefinition;
