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
import {
  conversationFlagIdKind,
  FLAG_ITEM_MAX_CHARS,
  FlagSchema,
} from "../../core";
import {
  FLAG_CATEGORIES,
  FlagCategorySchema,
} from "@plugins/conversations/plugins/conversation-view/plugins/push-and-exit/plugins/flag-categories/core";
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

Call it when the user asks you to wrap up (the push-and-exit prompt or an explicit "Exit") — never on your own, unless your Mandate says to close once your work is done. If anything went wrong or there's something worth surfacing, call \`flag_raise\` instead.`,
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

/** One line per category, as the agent reads them in the tool's description. */
const categoryLines = Object.entries(FLAG_CATEGORIES)
  .map(([id, c]) => `- \`${id}\` (${c.label}) — ${c.meaning}.`)
  .join("\n");

export const flagRaiseTool = Mcp.tool({
  name: "flag_raise",
  when: granted(flagRaise),
  description: `Raise a flag: your work is over, but the user must act on or decide something (the push didn't land, a failure you could not resolve, a choice only they can make). The conversation stays open for them, and whoever watches your task is told.

Each item has a \`category\`, drawn as a chip before it — the user decides from the chip alone whether the item is worth their attention:
${categoryLines}

Its \`text\` is one plain sentence about what happened, read at a glance without the context you have: "Push didn't land", "Some database tests fail, probably not from this change", "A 'Browser tab froze' report showed up while testing, probably unrelated" — never how you found it: no ids, paths, error text or jargon. Put that item's context (errors, ids, paths, what you checked) in its own \`detail\`: the user unfolds it under the item. Notes that belong to no one item and need no action go in \`details\`.

Use \`fyi\` sparingly: only for what the user would want to know even though nothing needs doing. A routine caveat (not tested by hand, a step skipped on purpose) belongs in your wrap-up, not the flag. If nothing needs the user and nothing is worth an \`fyi\`, call \`exit_clean\` instead, even if you have notes.

Call it in response to the push-and-exit prompt, or whenever your instructions tell you to raise a flag.`,
  inputSchema: {
    items: z
      .array(
        z.object({
          category: FlagCategorySchema.describe(
            "What the item asks of the user: broken, decide, fyi (sparingly) or other.",
          ),
          text: z
            .string()
            .max(FLAG_ITEM_MAX_CHARS)
            .describe(
              `What happened (at most ${FLAG_ITEM_MAX_CHARS} characters): a plain sentence the user understands at a glance, with no ids, paths, error text or jargon.`,
            ),
          detail: z
            .string()
            .optional()
            .describe(
              "The context behind this item (errors, ids, paths, what you checked). Shown folded under it.",
            ),
        }),
      )
      .min(1)
      .describe("What the user should see, one per item."),
    details: z
      .string()
      .optional()
      .describe(
        "Notes that belong to no one item and need no action. Shown folded under the items.",
      ),
  },
  async handler({ items, details }, { conversationId }) {
    const conversation = await getConversation(conversationId);
    if (conversation === null)
      throw new Error(`Conversation ${conversationId} not found.`);
    const { taskId } = conversation;
    // An empty `detail` / `details` is none.
    const flag = FlagSchema.parse({
      items: items.map(({ category, text, detail }) =>
        detail?.trim() ? { category, text, detail } : { category, text },
      ),
      details: details?.trim() ? details : null,
    });
    await db.transaction(async (tx) => {
      await tx.insert(_conversationFlags).values({
        id: conversationFlagIdKind.mint(),
        conversationId,
        taskId,
        items: flag.items,
        details: flag.details,
      });
      await conversationFlagRaised.emit(
        { conversationId, taskId, items: flag.items, details: flag.details },
        { tx: tx as unknown as EmitTx },
      );
    });
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true }) }],
    };
  },
});
