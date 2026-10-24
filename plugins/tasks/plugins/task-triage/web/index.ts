import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { ConfigV2 } from "@plugins/config_v2/web";
import { DynamicEnum } from "@plugins/fields/plugins/dynamic-enum/plugins/config/web";
import { useModelChoiceOptions } from "@plugins/conversations/plugins/model-provider/web";
import { FieldPresentation } from "@plugins/network/plugins/live/web";
import { TaskDetailSlots } from "@plugins/tasks/plugins/task-detail/web";
import { taskTriageShape } from "../core";
import { taskTriageConfig, triageModelField } from "../shared/config";
import { TriageCard } from "./components/triage-card";
import { TriageActions, TriageSummary } from "./components/triage-header";
import { investigateTriageRuns } from "./internal/investigate";

export default {
  description:
    "The Triage card in the task detail: the state chip and when it ran (or its place in the queue) in the header, with Conversation (the run's, for follow-up questions) and Re-run; the body per state — Run triage when none, a placeholder while queued or running, the read (Verdict · Priority · Type · Risk, the summary, one question with one-click answers), greyed under a Re-run notice when stale, the error with Re-run when failed — then the person's autosaved note and the Approve / ✓ Approved toggle, which needs no triage. Presents the exposed Triage, Priority, Type and Last triaged fields in every task list, and registers the triage config (its model picked from the live model catalog).",
  contributions: [
    TaskDetailSlots.Section({
      id: "triage",
      label: "Triage",
      summary: TriageSummary,
      actions: TriageActions,
      component: TriageCard,
      useDefaultOpen: () => true,
    }),
    // Triage, Priority, Type and Last triaged in every list whose rows reach
    // a task: enum chips in the vocabulary's tints (the shape's own options).
    FieldPresentation.Register({ owner: taskTriageShape.exposure }),
    // A failed run, in any list of triage reads: launch an agent on it.
    investigateTriageRuns,
    ConfigV2.WebRegister({ descriptor: taskTriageConfig }),
    // The model a run reads with, picked from the live model catalog.
    DynamicEnum.Options({
      field: triageModelField,
      useOptions: useModelChoiceOptions,
    }),
  ],
} satisfies PluginDefinition;
