import { defineServerContribution } from "@plugins/framework/plugins/server-core/core";

/**
 * What a close stops beyond the row: the runtime half of
 * `POST /api/conversations/:id/close`, run inside the request right after the
 * row moves to `done`, so the agent has stopped by the time the request
 * returns. The desktop's machine half contributes the agent stop
 * (`deleteConversation`); a host without the computer runs no agent and
 * contributes none, so its close is the row alone.
 */
export interface CloseTeardownSpec {
  /** Stable id, for logs and the docs. */
  id: string;
  stop(conversationId: string): Promise<void>;
}

export const CloseTeardown = defineServerContribution<CloseTeardownSpec>(
  "conversations.close.teardown",
  { docLabel: (t) => t.id },
);
