import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { db } from "@plugins/database/server";
import type { EmitTx } from "@plugins/infra/plugins/events/server";
import {
  getConversation,
  updateConversation,
} from "@plugins/tasks/plugins/tasks-core/server";
import { granted } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { flagRaise } from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/capabilities/core";
import { exitCleanFinalizeJob } from "./exit-clean-finalize-job";
import { _conversationFlags } from "./tables";
import { conversationFlagIdKind } from "../../core";
import { conversationFlagRaised } from "./tables-events";

// `exit_clean` and `flag_raise` are the model-facing terminus of the
// push-and-exit flow. The toolbar button just fires the wrap-up prompt
// (fire-and-forget) — there is no job row; the conversation's own status
// drives the button state.
//
// `exit_clean` marks the conversation close-requested and enqueues a finalize
// job that waits for end_turn before tearing down the runtime — calling
// `deleteConversation` here would yank the agent process out from under a
// still-streaming response. `flag_raise` records the flag
// (`conversation_flags`) and emits `conversation.flagRaised` in one
// transaction — whoever watches the task hears it; the conversation stays open
// (returns to `waiting`) and the flag text is still rendered inline in the
// transcript by the flag-raise tool-call renderer.
//
// `exit_clean` is visible to every conversation (a scratch profile still sees
// only its own allowlist): any agent can close itself. WHEN it should is its
// mandate's `exit.clean` grant (instructions only — on request, or when done).
// `flag_raise` is visible only to a mandate granting `flag.raise`. Both
// handlers are callable outside the toolbar-initiated flow so the model can
// call them in response to an explicit "Exit" instruction.

export const exitCleanTool = Mcp.tool({
  name: "exit_clean",
  description: `Close this conversation cleanly: your work is finished (the branch landed, or there was nothing to land) and there's nothing the user needs to know about. The conversation will close automatically after this turn ends.

Call it when your mandate says to (on request — the push-and-exit prompt or an explicit "Exit" — or on your own once your work is done). If anything went wrong or there's something worth surfacing, call \`flag_raise\` instead.`,
  inputSchema: {},
  async handler(_args, { conversationId }) {
    await updateConversation(conversationId, { closeRequested: true });
    await exitCleanFinalizeJob.enqueue({ conversationId });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ ok: true, deferred: "close on end_turn" }),
        },
      ],
    };
  },
});

export const flagRaiseTool = Mcp.tool({
  name: "flag_raise",
  when: granted(flagRaise),
  description: `Signal that the push-and-exit flow finished but something needs the user's attention — caveats, partial outcomes, follow-ups, skipped work, or the push didn't land. \`reason\` should be a short bullet list of what the user should know. The conversation stays open for the user to review, and whoever watches your task is told.

Call it in response to the push-and-exit prompt, or whenever your instructions tell you to raise a flag.`,
  inputSchema: {
    reason: z
      .string()
      .min(1)
      .describe(
        "Short bullets describing what the user should know — caveats, partial outcomes, follow-ups, skipped work, or push failure details.",
      ),
  },
  async handler({ reason }, { conversationId }) {
    const conversation = await getConversation(conversationId);
    if (conversation === null)
      throw new Error(`Conversation ${conversationId} not found.`);
    const { taskId } = conversation;
    await db.transaction(async (tx) => {
      await tx.insert(_conversationFlags).values({
        id: conversationFlagIdKind.mint(),
        conversationId,
        taskId,
        reason,
      });
      await conversationFlagRaised.emit(
        { conversationId, taskId, reason },
        { tx: tx as unknown as EmitTx },
      );
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    };
  },
});
