import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationCreated } from "@plugins/tasks/plugins/tasks-core/server";
import { conversationPrepromptRowsServed } from "./internal/resource";
import { recordPrepromptJob } from "./internal/record-job";
// Registers the launch snapshots' saved-icon source (module eval).
import "./internal/saved-icons";

export { conversationPreprompt } from "./internal/tables";
export { recordConversationPreprompt } from "./internal/record";
export { recordPrepromptJob } from "./internal/record-job";

export default {
  description:
    "Snapshots the launching task's selected preprompt (id + title + text) onto each newly created conversation, surfaced as a chip in the conversation header.",
  contributions: [
    ...conversationPrepromptRowsServed.declare,
    Trigger({
      on: conversationCreated,
      do: recordPrepromptJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [recordPrepromptJob],
} satisfies ServerPluginDefinition;
