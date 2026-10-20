import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationCreated } from "@plugins/tasks/plugins/tasks-core/server";
import { recordPrepromptJob } from "./internal/record-job";

export default {
  description:
    "Conversation preprompt, desktop-only half: on every new conversation, snapshots the launching task's selected preprompt — resolved from the preprompts library config — onto the conversation.",
  contributions: [
    Trigger({
      on: conversationCreated,
      do: recordPrepromptJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [recordPrepromptJob],
} satisfies MachinePluginDefinition;
