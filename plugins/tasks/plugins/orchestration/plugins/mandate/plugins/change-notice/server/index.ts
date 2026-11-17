import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { taskMandateChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { onMandateChangedJob } from "./internal/jobs";

export default {
  description:
    "A running agent follows a change of its task's mandate without a restart: on tasks.mandateChanged each live agent on those tasks reconnects the equin MCP server (its tools are the new mandate's at once), then is sent every system-prompt section that follows the mandate (Mandate, Supervisor prompt, Task tree…), rendered again — and those that no longer apply named — as an event turn — its system prompt is fixed for the life of its process. The notice is typed now, the way a user message is (a working agent reads it at its next step), and says it is information only, not a request to act; an agent this backend does not run gets none.",
  contributions: [
    Trigger({
      on: taskMandateChanged,
      do: onMandateChangedJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [onMandateChangedJob],
} satisfies ServerPluginDefinition;
