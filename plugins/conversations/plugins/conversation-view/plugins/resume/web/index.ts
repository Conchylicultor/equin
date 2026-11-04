import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Notifications } from "@plugins/shell/plugins/notifications/web";
import { resumeAction } from "./internal/use-resume-conversation";
export { useRetryLaunch } from "./internal/use-retry-launch";

export {
  useResumeConversation,
  type ResumeSubject,
} from "./internal/use-resume-conversation";

export default {
  description:
    "Toolbar button that resumes a gone conversation via `claude --resume <claude-id>`; useResumeConversation (the one browser resume, whose failure is a 'Couldn't resume conversation' notification) and that notification's Retry (the resume action kind); useRetryLaunch, which re-runs the launch of a conversation that failed to start.",
  contributions: [Notifications.Action(resumeAction)],
} satisfies PluginDefinition;
