import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationTurnCompleted } from "@plugins/conversations/server";
import { checkpointTurnJob } from "./internal/job";

export default {
  description:
    "Records a version of every prototype an agent turn touched, at the end of that turn: reads the turn's window out of the conversation transcript, finds the prototype ids its tool calls named (Edit/Write paths, Bash commands, an Agent call's prompt — and, for a turn woken by a background task's completion, the call that started that task), and checkpoints each through the files plugin's version store with the turn's request and summary.",
  contributions: [
    Trigger({
      on: conversationTurnCompleted,
      do: checkpointTurnJob,
      with: {},
      oneShot: false,
    }),
  ],
  register: [checkpointTurnJob],
} satisfies ServerPluginDefinition;
