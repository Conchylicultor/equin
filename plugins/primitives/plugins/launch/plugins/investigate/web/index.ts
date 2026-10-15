import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";

export {
  InvestigateAction,
  type InvestigateActionProps,
  type InvestigateLinkProps,
  type InvestigatePresentation,
  type InvestigateSubjectProps,
} from "./components/investigate-action";
export {
  Investigate,
  type InvestigateRegistration,
} from "./components/register";

export default {
  description:
    "The one 'launch an agent to investigate this failure' affordance: <InvestigateAction> — a fixed icon, label and popover, briefed by the caller, filed about the failed record (tasks/task-subject) so a second launch reuses its task and the action turns into View task.",
  contributions: [],
} satisfies PluginDefinition;
