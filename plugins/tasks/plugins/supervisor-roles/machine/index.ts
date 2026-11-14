import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { eventField, Trigger } from "@plugins/infra/plugins/events/server";
import { supervisorRoleIconStale } from "../server";
import { backlogArrivalSource } from "./internal/backlog-source";
import { supervisorRoleIconJob } from "./internal/icon-job";

export default {
  description:
    "Supervisor roles, desktop half: picks each role's icon with Claude Haiku from its name and description when it goes stale (created, or edited while the icon is Haiku's) — never over a person's pick; and tells a role's live session of each task entering its backlog (a `backlog` watch event routed to the session root's tree watch, delivered as an event turn once the agent is idle).",
  register: [supervisorRoleIconJob],
  contributions: [
    ...backlogArrivalSource,
    Trigger({
      on: supervisorRoleIconStale,
      do: supervisorRoleIconJob,
      with: { roleId: eventField("roleId") },
      oneShot: false,
    }),
  ],
} satisfies MachinePluginDefinition;
