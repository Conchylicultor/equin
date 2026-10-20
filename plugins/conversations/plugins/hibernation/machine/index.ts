import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { hibernationConfig } from "@plugins/conversations/core";
import { hibernateIdleJob } from "./internal/hibernate-idle-job";
import { handleResume } from "./internal/handle-resume";
import { resumeHibernated } from "../shared/endpoints";

export default {
  description:
    "Idle-conversation hibernation, desktop-only half: the scheduled idle-kill job, the resume-hibernated endpoint (respawns the agent session), and the global hibernation config.",
  httpRoutes: {
    [resumeHibernated.route]: handleResume,
  },
  contributions: [ConfigV2.Register({ descriptor: hibernationConfig })],
  register: [hibernateIdleJob],
} satisfies MachinePluginDefinition;
