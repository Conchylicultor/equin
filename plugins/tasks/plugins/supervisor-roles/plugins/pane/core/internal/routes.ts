import { defineRoute } from "@plugins/primitives/plugins/pane/core";

/** The Supervisors pane, in the agent manager: every role and ad-hoc supervisor. */
export const supervisorsRoute = defineRoute({
  id: "supervisors",
  segment: "supervisors",
});

/** One supervisor role: its inline settings, session, backlog and sessions. */
export const supervisorRoleRoute = defineRoute({
  id: "supervisor-role",
  segment: "role/:roleId",
  parent: supervisorsRoute,
});

/** The pinned "All supervisors" entry: the prompt every supervisor shares. */
export const supervisorsSharedRoute = defineRoute({
  id: "supervisors-shared",
  segment: "all",
  parent: supervisorsRoute,
});
