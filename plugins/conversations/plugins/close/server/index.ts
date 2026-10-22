import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";
import { closeConversation } from "@plugins/conversations/core";
import { handleClose } from "./internal/handle-close";

export { CloseTeardown } from "./internal/teardown";
export type { CloseTeardownSpec } from "./internal/teardown";

export default {
  portable: true,
  description:
    "Closing a conversation, portable half: POST /api/conversations/:id/close marks it done on every host (markConversationClosed) — the demo's in-browser server included — then runs every CloseTeardown contribution before it returns (the desktop's stops the agent).",
  httpRoutes: {
    [closeConversation.route]: handleClose,
  },
} satisfies ServerPluginDefinition;
