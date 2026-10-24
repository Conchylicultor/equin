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
import {
  jobRunsPresentation,
  jobsPresentation,
} from "./internal/job-presentation";
import { symbol } from "@plugins/ui/plugins/icons/core";

export { queuePane } from "./panes";

export default {
  description:
    "Debug → Queue: the jobs queue as live DataViews with side detail panes — Queue (the host's live job queue, a windowed external collection: status, hold class, attempts, run-at, error, per-state counts; Retry / Cancel), History (the recorded runs, a windowed collection: outcome, duration against the class ceiling, slot wait, error; Run now) — a job leaves Queue for History when its run finishes, and an open detail follows it — Dead (the dead-letter archive), Events (the emit() log, matched or not) and Triggers (every event→job subscription, enable / disable / delete).",
  contributions: [
    jobsPresentation,
    jobRunsPresentation,
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
