import { and, eq, like } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { FALLBACK_MODEL } from "@plugins/conversations/plugins/model-provider/core";
import { DEFAULT_CONVERSATION_RUNTIME } from "@plugins/conversations/plugins/runtime-catalog/core";
import { recordSessionId } from "@plugins/conversations/plugins/session-chain/server";
import { refreshConversationChain } from "@plugins/conversations/plugins/transcript-watcher/server";
import { conversationIdKind } from "@plugins/tasks/plugins/task-ids/core";
import {
  deleteConversationRow,
  getConversation,
  insertConversation,
  moveConversationToAttempt,
  updateConversation,
} from "@plugins/tasks/plugins/tasks-core/server";
import {
  _pageBlocksAgentAuthors,
  recordAgentNotesAuthor,
} from "@plugins/page/plugins/annotations/plugins/agent-notes/plugins/authorship/server";
import { _dataViewRowOrder } from "@plugins/primitives/plugins/data-view/plugins/view-order/server";
import {
  narrowingFixture,
  NARROWING_FIXTURE_DATA_VIEW,
  NARROWING_FIXTURE_SPAWNED_BY,
} from "../../core";

// The conversation ids an author stamp is made under: minted here, never a
// real conversation's (`conversation_id` has no foreign key).
const AUTHOR_PREFIX = `${NARROWING_FIXTURE_SPAWNED_BY}-`;

// The fixture's own conversations only: a real conversation's attempt and
// session chain are never written (the chain is append-only — a synthetic id
// recorded on a real conversation could never be taken back).
async function fixtureConversation(id: string): Promise<void> {
  const row = await getConversation(id);
  if (row === null) throw new HttpError(404, `Unknown conversation "${id}"`);
  if (row.spawnedBy !== NARROWING_FIXTURE_SPAWNED_BY) {
    throw new HttpError(
      409,
      `Conversation "${id}" is not a narrowing-fixture conversation (spawnedBy ${String(row.spawnedBy)})`,
    );
  }
}

export const handleNarrowingFixture = implement(
  narrowingFixture,
  async ({ body }) => {
    // Main's data is the user's: the measurement runs on a worktree's fork.
    if (isMain()) {
      throw new HttpError(403, "the narrowing fixture never writes main");
    }
    switch (body.action) {
      case "create-conversation": {
        const id = conversationIdKind.mint();
        await insertConversation({
          id,
          attemptId: body.attemptId,
          runtime: DEFAULT_CONVERSATION_RUNTIME,
          model: FALLBACK_MODEL,
          spawnedBy: NARROWING_FIXTURE_SPAWNED_BY,
          // Closed from the start: no runtime holds it, so the status
          // reconciler (which reads only active rows) never writes it.
          status: "done",
          title: "narrowing fixture",
        });
        return { conversationId: id };
      }
      case "record-session": {
        await fixtureConversation(body.conversationId);
        // What the status reconciler does on adopting a session id: the tail
        // on the row and the chain link in one transaction, then the watcher
        // re-pointed.
        const sessionId = crypto.randomUUID();
        await updateConversation(
          body.conversationId,
          { claudeSessionId: sessionId },
          {
            alongside: (tx) =>
              recordSessionId(body.conversationId, sessionId, tx),
          },
        );
        await refreshConversationChain(body.conversationId);
        return { conversationId: body.conversationId };
      }
      case "move-conversation": {
        await fixtureConversation(body.conversationId);
        await moveConversationToAttempt(body.conversationId, body.attemptId);
        return { conversationId: body.conversationId };
      }
      case "delete-conversation": {
        await fixtureConversation(body.conversationId);
        await deleteConversationRow(body.conversationId);
        return { conversationId: body.conversationId };
      }
      case "stamp-agent-author": {
        const conversationId = `${AUTHOR_PREFIX}${crypto.randomUUID()}`;
        await recordAgentNotesAuthor(body.blockId, conversationId);
        return { conversationId };
      }
      case "clear-agent-authors": {
        await db
          .delete(_pageBlocksAgentAuthors)
          .where(
            and(
              eq(_pageBlocksAgentAuthors.blockId, body.blockId),
              like(_pageBlocksAgentAuthors.conversationId, `${AUTHOR_PREFIX}%`),
            ),
          );
        return { conversationId: null };
      }
      case "clear-row-order": {
        if (!body.dataViewId.startsWith(NARROWING_FIXTURE_DATA_VIEW)) {
          throw new HttpError(
            409,
            `Data view "${body.dataViewId}" is not a narrowing-fixture data view (prefix ${NARROWING_FIXTURE_DATA_VIEW})`,
          );
        }
        await db
          .delete(_dataViewRowOrder)
          .where(eq(_dataViewRowOrder.dataViewId, body.dataViewId));
        return { conversationId: null };
      }
    }
  },
);
