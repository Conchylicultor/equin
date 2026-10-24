import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { ConfigV2 } from "@plugins/config_v2/server";
import { LiveColumns } from "@plugins/network/plugins/live/server";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { ScratchProfile } from "@plugins/conversations/plugins/workspace/server";
import {
  conversationStatusChanged,
  taskDescriptionChanged,
  taskTitleChanged,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  answerTriageEndpoint,
  runTriageEndpoint,
  setTriageNoteEndpoint,
} from "../core";
import { taskTriageConfig } from "../shared/config";
import { triageDispatchJob, triageDispatchWarmup } from "./internal/dispatch";
import {
  triageConversationStatusJob,
  triageEditedJob,
  triageSweepJob,
} from "./internal/jobs";
import { submitTriageTool } from "./internal/mcp-tool";
import { triageProfile } from "./internal/profile";
import {
  taskTriageNotesServed,
  taskTriageReadsServed,
} from "./internal/resource";
import {
  handleAnswerTriage,
  handleRunTriage,
  handleSetTriageNote,
} from "./internal/routes";
import { tasksTriage } from "./internal/tables";

export { requestTriage } from "./internal/dispatch";
export type { RequestTriageResult } from "./internal/dispatch";
export {
  getTriageNote,
  getTriageRead,
  triageNotesOf,
  triageReadsOf,
} from "./internal/state";
export { tasksTriage, tasksTriageNote } from "./internal/tables";

export default {
  description:
    "Owns task triage: the tasks_ext_triage side-table (one read per task — run state queued / running / done / stale / failed, verdict, MoSCoW priority, type, risk, context, one one-click question) and tasks_ext_triage_note (the person's note, fed to every run). A run is a read-only `system` conversation in a `tasks.triage` scratch workspace (Edit / Write / NotebookEdit / Bash denied) under the triaged task's own `Triage: …` run task (System category, subject `task-triage`), reporting through its task_submit_triage MCP tool; a dispatcher job launches queued runs `concurrency` at a time. A read goes stale when the task's text changes or after `staleAfterDays`; a run whose conversation closes without a read, or that has not submitted after 30 min, fails. Exposes Triage, Priority, Type and Last triaged to every list of tasks; requestTriage is the API other plugins queue a read with.",
  httpRoutes: {
    [runTriageEndpoint.route]: handleRunTriage,
    [answerTriageEndpoint.route]: handleAnswerTriage,
    [setTriageNoteEndpoint.route]: handleSetTriageNote,
  },
  contributions: [
    ConfigV2.Register({ descriptor: taskTriageConfig }),
    ...taskTriageReadsServed.declare,
    ...taskTriageNotesServed.declare,
    // Triage, Priority, Type and Last triaged, folded into every list whose
    // rows reach a task.
    LiveColumns.Expose(tasksTriage),
    Trigger({
      on: taskTitleChanged,
      do: triageEditedJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: taskDescriptionChanged,
      do: triageEditedJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: conversationStatusChanged,
      do: triageConversationStatusJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [
    triageDispatchJob,
    triageDispatchWarmup,
    triageEditedJob,
    triageConversationStatusJob,
    triageSweepJob,
    ScratchProfile.define(triageProfile),
    submitTriageTool,
  ],
} satisfies ServerPluginDefinition;
