import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import {
  conversationRunHandedOver,
  taskMandateChanged,
} from "@plugins/tasks/plugins/tasks-core/server";
import { onMandateChangedJob, onRunHandedOverJob } from "./internal/jobs";

export { sendSectionNotice } from "./internal/send";
export type { SectionNotice } from "./internal/send";

export default {
  description:
    "A running agent follows a change of its task's mandate without a restart: on tasks.mandateChanged each live agent on those tasks reconnects the equin MCP server (its tools are the new mandate's at once), then is sent every system-prompt section that follows the mandate (Mandate, Supervisor prompt, Task tree…), rendered again — and those that no longer apply named — as an event turn (a side chat opened beside the agent running the task keeps its own mandate and is only told nothing changed for it; on conversation.runHandedOver, a side chat that takes over running its task once that agent closed gets the same refresh) — its system prompt is fixed for the life of its process. The notice is typed now, the way a user message is (a working agent reads it at its next step), and says it is information only, not a request to act; an agent this backend does not run gets none. The delivery is sendSectionNotice, which the owner of any other state a section renders (e.g. the supervisor roles list) calls with its own lead and its own section.",
  contributions: [
    Trigger({
      on: taskMandateChanged,
      do: onMandateChangedJob,
      with: {},
      oneShot: false,
    }),
    Trigger({
      on: conversationRunHandedOver,
      do: onRunHandedOverJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [onMandateChangedJob, onRunHandedOverJob],
} satisfies ServerPluginDefinition;
