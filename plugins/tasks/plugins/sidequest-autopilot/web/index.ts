import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import {
  Automations,
  automationConfigContributions,
} from "@plugins/tasks/plugins/automations/web";
import {
  sidequestAutopilotConfig,
  SIDEQUEST_AUTOPILOT_ID,
} from "../shared/config";
import { LaunchListSection } from "./components/launch-list-section";
import { RunUntilSection } from "./components/run-until-section";
import { TriageSection } from "./components/triage-section";

export default {
  description:
    "The Sidequest autopilot in the Automations pane: registers its config (enabled, at once, in total, push policy, model, prompt, triage, stale after, triage prompt) and contributes its sections — Launch list (a DataView of every ready sidequest in launch order, grouped Approved / Proposed by triage / Needs your call / Looks obsolete / Triaging / Excluded; each row expands to triage's context, its one-click question and Re-triage; triage may tick a row, only Approve selected approves), Run until (until you turn it off, or until a date and time after which it turns itself off) and Triage (the switch, stale after, the triage prompt).",
  contributions: [
    ...automationConfigContributions(sidequestAutopilotConfig),
    Automations.Section({
      id: "launch-list",
      automationId: SIDEQUEST_AUTOPILOT_ID,
      component: LaunchListSection,
    }),
    Automations.Section({
      id: "run-until",
      automationId: SIDEQUEST_AUTOPILOT_ID,
      component: RunUntilSection,
    }),
    Automations.Section({
      id: "triage",
      automationId: SIDEQUEST_AUTOPILOT_ID,
      component: TriageSection,
    }),
  ],
} satisfies PluginDefinition;
