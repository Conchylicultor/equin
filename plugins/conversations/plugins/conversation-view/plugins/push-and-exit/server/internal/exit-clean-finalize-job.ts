import { z } from "zod";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { afterTurn, deleteConversation } from "@plugins/conversations/server";
import {
  getConversation,
  markConversationClosed,
} from "@plugins/tasks/plugins/tasks-core/server";
import { dropTaskOnExit } from "@plugins/conversations/plugins/conversation-view/plugins/drop-and-exit/server";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { conversationRoute } from "@plugins/conversations/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";

const FINALIZE_TIMEOUT_MS = 60_000;

// Spawned by the `exit_clean` MCP tool. Defers `deleteConversation` until
// after the model's current turn ends, so the closing agent kill doesn't
// race against a still-streaming response. If end_turn doesn't arrive
// within FINALIZE_TIMEOUT_MS we delete anyway — the model has already
// signalled clean exit, so missing the end_turn (transcript poll lag,
// missed event) shouldn't strand the conversation.
export const exitCleanFinalizeJob = defineJob({
  name: "push_and_exit.exit_clean_finalize",
  description:
    "Closes a conversation after the agent signals a clean exit, once its current turn ends, and notifies the user.",
  // seconds — and NOT `minutes`, despite FINALIZE_TIMEOUT_MS being 60s: that
  // number bounds a `ctx.waitFor`, which RETURNS from `run` and releases the
  // slot. The wait costs no hold at all. What this classifies is the resumed
  // dispatch: `dropTaskOnExit` (git-measured attempt standing) plus one untimed
  // agent stop, both bounded local operations.
  hold: "seconds",
  input: z.object({ conversationId: z.string() }),
  // Direct-enqueue only (spawned by the exit_clean MCP tool).
  event: z.never(),
  dedup: { key: (input) => input.conversationId },
  maxAttempts: 3,
  run: async ({ input: { conversationId }, ctx }) => {
    await afterTurn(ctx, conversationId, { timeoutMs: FINALIZE_TIMEOUT_MS });
    await ctx.step("close-conversation", async () => {
      // An agent that exits without landing any work should return its task to
      // `dropped` rather than leaving it stranded as `attempted`. Stricter than
      // the manual "Drop & Close" (which drops anything not yet in `main`): no
      // human chose to drop here, so it never drops when the attempt's
      // git-measured standing shows any work at stake (pending included) or
      // cannot be measured at all. This is the path that used to drop the
      // task of an agent that pushed and then called `exit_clean`, because the
      // guard read the lagging pushes ledger.
      const conversation = await getConversation(conversationId);
      const dropped = conversation
        ? await dropTaskOnExit(conversation, "only-if-no-work")
        : false;

      await markConversationClosed(conversationId);
      await deleteConversation(conversationId);
      // Server-side terminus of the clean push-and-exit flow: persist the
      // close notification exactly once (the client used to fire this toast
      // from a per-tab effect, duplicating the row per open tab). The copy
      // reflects whether work actually landed.
      await recordNotification({
        type: "conversation",
        title: dropped ? "Closed without pushing" : "Pushed and closed",
        description: dropped
          ? "No changes were pushed — task marked as dropped"
          : "Branch pushed and conversation closed",
        variant: dropped ? "info" : "success",
        linkTo: conversationRoute.link(agentManagerApp, {
          convId: conversationId,
        }),
        dedupeKey: `push-and-exit-clean:${conversationId}`,
      });
    });
  },
});
