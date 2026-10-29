import {
  serveCollection,
  type ColumnOverride,
} from "@plugins/network/plugins/live/server";
import {
  attemptConversationIds,
  attemptDeliveries,
  attemptPushIds,
  conversationRuntimes,
  conversationSessionTails,
  conversationWorkspaces,
} from "../../core";
import { conversationAttemptJoin } from "./conversation-owner";
import { _attemptDeliveries, _conversations, pushes } from "./tables";

// The follow targets (core: `../../core/resources.ts`, *Follow targets*) as
// they bind to the database — the ONE spelling the served handles below and
// the oracle (`./follow-targets-oracle.test.ts`, which compiles them against
// a throwaway database) read. Every row field binds to a column of its base
// table by name, so each collection's routes read exactly its picked columns
// (its gate); `conversationWorkspaces`' two attempt columns bind through the
// attempt join. `attemptWorkspaces` is served beside the lists
// (`./resources.ts`): it predates the follows.

/** `attempt-conversation-ids`: one attempt's conversations, every kind. */
export const attemptConversationIdsServeOptions = { from: _conversations };

/** `attempt-push-ids`: one attempt's pushes. */
export const attemptPushIdsServeOptions = { from: pushes };

/** `attempt-deliveries`: an attempt's non-push delivery, by its key. */
export const attemptDeliveriesServeOptions = { from: _attemptDeliveries };

type AttemptJoins = readonly [typeof conversationAttemptJoin];

/**
 * `conversation-workspaces`: a conversation with its attempt joined — the
 * attempt's checkout path and workspace spec (a `jsonb` column decoded by
 * the field's schema through the join).
 */
export const conversationWorkspacesServeOptions = {
  from: _conversations,
  joins: [conversationAttemptJoin] as const,
  columns: {
    worktreePath: (j) => j.attempt.worktreePath,
    workspace: (j) => j.attempt.workspace,
  } satisfies Record<
    "worktreePath" | "workspace",
    ColumnOverride<typeof _conversations, AttemptJoins>
  >,
};

/** `conversation-session-tails`: a conversation's live Claude session id. */
export const conversationSessionTailsServeOptions = { from: _conversations };

/** `conversation-runtimes`: a conversation's runtime and status. */
export const conversationRuntimesServeOptions = { from: _conversations };

export const attemptConversationIdsServed = serveCollection(
  attemptConversationIds,
  attemptConversationIdsServeOptions,
);
export const attemptPushIdsServed = serveCollection(
  attemptPushIds,
  attemptPushIdsServeOptions,
);
export const attemptDeliveriesServed = serveCollection(
  attemptDeliveries,
  attemptDeliveriesServeOptions,
);
export const conversationWorkspacesServed = serveCollection(
  conversationWorkspaces,
  conversationWorkspacesServeOptions,
);
export const conversationSessionTailsServed = serveCollection(
  conversationSessionTails,
  conversationSessionTailsServeOptions,
);
export const conversationRuntimesServed = serveCollection(
  conversationRuntimes,
  conversationRuntimesServeOptions,
);
