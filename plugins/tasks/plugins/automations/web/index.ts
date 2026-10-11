import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { DynamicEnum } from "@plugins/fields/plugins/dynamic-enum/plugins/config/web";
import { useModelChoiceOptions } from "@plugins/conversations/plugins/model-provider/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { opensPane } from "@plugins/primitives/plugins/app-shell/web";
import { Shell } from "@plugins/shell/web";
import { Tasks } from "@plugins/tasks/plugins/task-list/web";
import { symbol } from "@plugins/ui/plugins/icons/core";
import { automationModelField } from "../core";
import { automationDetailPane, automationsPane } from "./panes";
import { OriginField } from "./components/origin-field";
import { Automations } from "./internal/slots";

export { Automations, automationConfigContributions } from "./internal/slots";
export { PromptTemplateBlock } from "./components/prompt-section";

export default {
  description:
    "Automations in the agent manager: the Automations sidebar entry and list (a DataView over the catalog — trigger in words, next run, on/off, open task), the detail pane (Run now through Background activity; Behavior — enabled, model, push policy; Trigger — schedule presets or custom cron, or the event and its settle wait; the sections an automation contributes through Automations.Section; its sources; the Prompt template with Customized / Reset to default — PromptTemplateBlock, the same editor for any template field an automation declares; and the History of the tasks it filed or started — each row expandable into the Automations.TaskDetail contributions for its task), the `origin` Automation field in every task DataView, and automationConfigContributions — how a declaring plugin registers its automation's config document (Automations.Config).",
  contributions: [
    // Every automation's model is picked from the live model catalog: the
    // field object is shared by every automation config.
    DynamicEnum.Options({
      field: automationModelField,
      useOptions: useModelChoiceOptions,
    }),
    Pane.Register({ pane: automationsPane }),
    Pane.Register({ pane: automationDetailPane }),
    Shell.Sidebar({
      id: "automations",
      title: "Automations",
      icon: symbol("auto-mode"),
      opens: opensPane(automationsPane, {}),
    }),
    Tasks.Fields({ id: "origin", section: null, component: OriginField }),
  ],
  slots: {
    "automation-config": Automations.Config,
    "automation-section": Automations.Section,
    "automation-task-detail": Automations.TaskDetail,
    automations: automationsPane,
    "automation-detail": automationDetailPane,
  },
} satisfies PluginDefinition;
