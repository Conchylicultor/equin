import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { opensPane } from "@plugins/primitives/plugins/app-shell/web";
import { Shell } from "@plugins/shell/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import {
  supervisorRolePane,
  supervisorsPane,
  supervisorsSharedPane,
} from "./panes";
import { SupervisorsSidebarTrail } from "./components/sidebar-trail";
import {
  AdhocActions,
  RoleActions,
  supervisorsListActions,
} from "./components/supervisors-list";
import { BacklogActions, backlogActions } from "./components/backlog-section";

export {
  SupervisorPill,
  TaskSupervisorControl,
} from "./components/supervisor-control";

export default {
  description:
    "The Supervisors pane, in the agent manager: one sidebar entry (live sessions and the tasks waiting in every backlog at its edge) opening the list — the pinned All supervisors entry (the shared prompt, edited inline), every role (session state, backlog and its oldest age, Launch / Open session) and the ad-hoc supervisors at work — and a role's page: its name and icon (picked automatically, overridable) and every setting edited in place (listed to agents, the description agents get, the supervisor prompt), the Launch / Open session band, the backlog (Adopt — into the live session, launching one when none is live — and Drop) and the session history. Also the task detail's Supervisor pill (TaskSupervisorControl: picking another role re-routes the task, None removes its role) and SupervisorPill.",
  contributions: [
    Pane.Register({ pane: supervisorsPane }),
    Pane.Register({ pane: supervisorRolePane }),
    Pane.Register({ pane: supervisorsSharedPane }),
    Shell.Sidebar({
      id: "supervisors",
      title: "Supervisors",
      icon: symbol("cell-tower"),
      opens: opensPane(supervisorsPane, {}),
      trail: SupervisorsSidebarTrail,
    }),
    ...supervisorsListActions,
    ...backlogActions,
  ],
  slots: {
    supervisors: supervisorsPane,
    "supervisor-role": supervisorRolePane,
    "supervisors-shared": supervisorsSharedPane,
    "role-actions": RoleActions,
    "adhoc-actions": AdhocActions,
    "backlog-actions": BacklogActions,
  },
} satisfies PluginDefinition;
