import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { updateConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { exitCleanFinalizeJob } from "./exit-clean-finalize-job";

// `exit_clean` and `flag_raise` are the model-facing terminus of the
// push-and-exit flow. The toolbar button just fires the wrap-up prompt
// (fire-and-forget) — there is no job row; the conversation's own status
// drives the button state.
//
// `exit_clean` marks the conversation close-requested and enqueues a finalize
// job that waits for end_turn before tearing down the runtime — calling
// `deleteConversation` here would yank the agent process out from under a
// still-streaming response. `flag_raise` is a pure no-op signal: the
// conversation stays open (returns to `waiting`) and the flag text is rendered
// inline in the transcript by the flag-raise tool-call renderer.
//
// Both handlers are callable outside the toolbar-initiated flow so the model
// can call them in response to an explicit "Exit" instruction.

export const exitCleanTool = Mcp.tool({
  name: "exit_clean",
  description: `Signal that the push-and-exit flow finished cleanly: the branch landed and there's nothing the user needs to know about. The conversation will close automatically after this turn ends.

Only call this in response to the push-and-exit prompt. If anything went wrong or there's something worth surfacing, call \`flag_raise\` instead.`,
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
  description: `Signal that the push-and-exit flow finished but something needs the user's attention — caveats, partial outcomes, follow-ups, skipped work, or the push didn't land. \`reason\` should be a short bullet list of what the user should know. The conversation stays open for the user to review.

Only call this in response to the push-and-exit prompt.`,
  inputSchema: {
    reason: z
      .string()
      .min(1)
      .describe(
        "Short bullets describing what the user should know — caveats, partial outcomes, follow-ups, skipped work, or push failure details.",
      ),
  },
  async handler({ reason }, _ctx) {
    // No-op beyond acknowledging: the flag text is already rendered inline in
    // the conversation transcript by the flag-raise tool-call renderer.
    void reason;
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    };
  },
});
