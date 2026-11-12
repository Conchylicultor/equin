import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { Trigger } from "@plugins/infra/plugins/events/server";
import { conversationStatusChanged } from "@plugins/tasks/plugins/tasks-core/server";
import {
  agentsIdleBlocker,
  agentsIdleNotifyJob,
} from "./internal/agents-blocker";

export default {
  description:
    "Idle blocker `agents`: any conversation starting or working (isAgentBusy) keeps the host busy; every conversation.statusChanged that crosses that line asks the idle signal to re-evaluate.",
  register: [agentsIdleNotifyJob],
  contributions: [
    agentsIdleBlocker,
    Trigger({
      on: conversationStatusChanged,
      do: agentsIdleNotifyJob,
      with: {},
      oneShot: false,
    }),
  ],
} satisfies ServerPluginDefinition;
