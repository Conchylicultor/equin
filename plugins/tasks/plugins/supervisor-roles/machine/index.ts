import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { eventField, Trigger } from "@plugins/infra/plugins/events/server";
import { supervisorRoleIconStale } from "../server";
import { supervisorRoleIconJob } from "./internal/icon-job";

export default {
  description:
    "Supervisor roles, desktop half: picks each role's icon with Claude Haiku from its name and description when it goes stale (created, or edited while the icon is Haiku's) — never over a person's pick.",
  register: [supervisorRoleIconJob],
  contributions: [
    Trigger({
      on: supervisorRoleIconStale,
      do: supervisorRoleIconJob,
      with: { roleId: eventField("roleId") },
      oneShot: false,
    }),
  ],
} satisfies MachinePluginDefinition;
