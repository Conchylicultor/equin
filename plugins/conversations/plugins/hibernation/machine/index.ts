import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { hibernateIdleJob } from "./internal/hibernate-idle-job";
import { handleResume } from "./internal/handle-resume";
import { resumeHibernated } from "../shared/endpoints";

export default {
  description:
    "Idle-conversation hibernation, desktop-only half: the scheduled idle-kill job and the resume-hibernated endpoint (respawns the agent session), both reading the config the portable half registers.",
  httpRoutes: {
    [resumeHibernated.route]: handleResume,
  },
  register: [hibernateIdleJob],
} satisfies MachinePluginDefinition;
