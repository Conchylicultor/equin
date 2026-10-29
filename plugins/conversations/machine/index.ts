import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { contextUsageServed } from "./internal/context-usage";
import { partialMessageServed } from "./internal/partial-message";
import { handleCreate } from "./internal/handle-create";
import { handleInterrupt } from "./internal/handle-interrupt";
import { handlePostTurn } from "./internal/handle-post-turn";
import { handleRetryTurn } from "./internal/handle-retry-turn";
import { handleStop } from "./internal/handle-stop";
import { handleWithdrawTurn } from "./internal/handle-withdraw-turn";
import {
  createConversation,
  interruptConversationTurn,
  postConversationTurn,
  retryConversationTurn,
  stopConversation,
  withdrawConversationTurn,
} from "../core/endpoints";

export default {
  description:
    "The conversations domain's desktop half: the conversations.partial-message live value — the text the agent is writing, held in memory while a page watches, from the conversation's runtime (watchPartial) — and the conversations.context-usage live value, the agent's own measure of its context window (contextUsage), re-measured as its own conversation's runtime or status moves (a follow of tasks-core's conversationRuntimes — another conversation's write never re-asks the agent). And the endpoints that drive an agent, each declared needsMachine: launching a conversation, sending a turn (and retrying or withdrawing a failed one), interrupting the running turn so a queued message starts now, and stopping it.",
  httpRoutes: {
    [createConversation.route]: handleCreate,
    [postConversationTurn.route]: handlePostTurn,
    [retryConversationTurn.route]: handleRetryTurn,
    [withdrawConversationTurn.route]: handleWithdrawTurn,
    [interruptConversationTurn.route]: handleInterrupt,
    [stopConversation.route]: handleStop,
  },
  contributions: [
    ...partialMessageServed.declare,
    ...contextUsageServed.declare,
  ],
} satisfies MachinePluginDefinition;
