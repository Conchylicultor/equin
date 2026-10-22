import type { MachinePluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { contextUsageServed } from "./internal/context-usage";
import { partialMessageServed } from "./internal/partial-message";
import { handleCreate } from "./internal/handle-create";
import { handlePostTurn } from "./internal/handle-post-turn";
import { handleRetryTurn } from "./internal/handle-retry-turn";
import { handleStop } from "./internal/handle-stop";
import { handleWithdrawTurn } from "./internal/handle-withdraw-turn";
import {
  createConversation,
  postConversationTurn,
  retryConversationTurn,
  stopConversation,
  withdrawConversationTurn,
} from "../core/endpoints";

export default {
  description:
    "The conversations domain's desktop half: the conversations.partial-message live value — the text the agent is writing, held in memory while a page watches, from the conversation's runtime (watchPartial) — and the conversations.context-usage live value, the agent's own measure of its context window (contextUsage), re-measured as its conversation row moves. And the endpoints that drive an agent, each declared needsMachine: launching a conversation, sending a turn (and retrying or withdrawing a failed one) and stopping it.",
  httpRoutes: {
    [createConversation.route]: handleCreate,
    [postConversationTurn.route]: handlePostTurn,
    [retryConversationTurn.route]: handleRetryTurn,
    [withdrawConversationTurn.route]: handleWithdrawTurn,
    [stopConversation.route]: handleStop,
  },
  contributions: [
    ...partialMessageServed.declare,
    ...contextUsageServed.declare,
  ],
} satisfies MachinePluginDefinition;
