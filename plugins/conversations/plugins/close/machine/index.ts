import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { deleteConversation } from "@plugins/conversations/server";
import { conversationStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import { CloseTeardown } from "@plugins/conversations/plugins/close/server";
import { teardownClosedConversationJob } from "./internal/teardown-closed-job";

export default {
  description:
    "Closing a conversation, desktop-only half: the close endpoint stops the agent before it returns (CloseTeardown), and once a conversation's status moves to done any other way, a trigger stops its agent too (the runtime teardown).",
  contributions: [
    CloseTeardown({ id: "stop-agent", stop: deleteConversation }),
    Trigger({
      on: conversationStatusChanged,
      do: teardownClosedConversationJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [teardownClosedConversationJob],
} satisfies MachinePluginDefinition;
