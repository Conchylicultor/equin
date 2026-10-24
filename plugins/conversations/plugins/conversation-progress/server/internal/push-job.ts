import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { conversationProgress } from "./tables";

// Triggered on every `pushLanded` event. Sets phase = "pushed" for ALL
// conversations in the attempt — not just the one that ran ./equin push.
// Push is reliable and immediate; it is the terminal phase regardless of
// transcript content.
export const markProgressPushedJob = defineJob({
  name: "conversation-progress.mark-pushed",
  description:
    "Marks every conversation of an attempt as pushed when its work lands on main.",
  hold: "instant",
  input: z.object({}).passthrough(),
  event: z
    .object({
      conversationId: z.string(),
      attemptId: z.string().optional(),
    })
    .passthrough(),
  dedup: "none",
  maxAttempts: 2,
  run: async ({ event }) => {
    const conversationId = event?.conversationId;
    const attemptId = event?.attemptId;
    if (!conversationId) return;

    // Mark every conversation in the attempt so sibling conversations
    // (e.g. those that did the implementation work but didn't call push)
    // also advance to "pushed". Fall back to the single conversation if
    // attemptId is unavailable (legacy events in the queue).
    let ids: string[] = [conversationId];
    if (attemptId) {
      const rows = await db
        .select({ id: _conversations.id })
        .from(_conversations)
        .where(eq(_conversations.attemptId, attemptId));
      if (rows.length > 0) ids = rows.map((r) => r.id);
    }

    for (const cId of ids) {
      await conversationProgress.upsert(cId, {
        phase: "pushed",
        source: "push",
      });
    }
  },
});
