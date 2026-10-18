import type { PluginDefinition } from "@plugins/framework/plugins/web-sdk/core";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { DebugApp } from "@plugins/apps/plugins/debug/plugins/shell/web";
import {
  queuePane,
  jobDetailPane,
  deadDetailPane,
  emissionDetailPane,
  triggerDetailPane,
  QueueTabs,
} from "./panes";
import {
  JobsItemActions,
  RetryJobAction,
  CancelJobAction,
} from "./components/jobs-view";
import {
  TriggersItemActions,
  TriggerEnabledAction,
  DeleteTriggerAction,
} from "./components/triggers-view";
import { jobListPresentation } from "./internal/job-list-presentation";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { queuePane } from "./panes";

export default {
  description:
    "Debug → Queue: the jobs queue as live DataViews with side detail panes — Jobs (the live graphile queue merged with the recorded run history: status, hold class, attempts, when, slot wait, duration against the class ceiling, error; Retry / Cancel / Run now), Dead (the dead-letter archive), Events (the emit() log, matched or not) and Triggers (every event→job subscription, enable / disable / delete).",
  contributions: [
    jobListPresentation,
    Pane.Register({ pane: queuePane }),
    Pane.Register({ pane: jobDetailPane }),
    Pane.Register({ pane: deadDetailPane }),
    Pane.Register({ pane: emissionDetailPane }),
    Pane.Register({ pane: triggerDetailPane }),
    queuePane.Actions({ id: "tabs", component: QueueTabs }),
    JobsItemActions({ id: "retry", component: RetryJobAction }),
    JobsItemActions({ id: "cancel", component: CancelJobAction }),
    TriggersItemActions({
      id: "enabled",
      component: TriggerEnabledAction,
      zone: "persistent",
    }),
    TriggersItemActions({ id: "delete", component: DeleteTriggerAction }),
    DebugApp.Sidebar({
      id: "queue",
      title: "Queue",
      icon: symbol("library-add"),
      opens: { pane: queuePane, params: {} },
    }),
  ],
  slots: {
    queue: queuePane,
    "queue-job": jobDetailPane,
    "queue-dead": deadDetailPane,
    "queue-emission": emissionDetailPane,
    "queue-trigger": triggerDetailPane,
    jobActions: JobsItemActions,
    triggerActions: TriggersItemActions,
  },
} satisfies PluginDefinition;
