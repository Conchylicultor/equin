import { z } from "zod";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { addMemberToGroup } from "@plugins/conversations/plugins/conversations-view/plugins/grouped/server";
import { _improvePendingGroups } from "./tables";

export const applyGroupJob = defineJob({
  name: "improve.apply-group",
  description:
    "Adds a newly started conversation to the group chosen when its improvement task was filed.",
  hold: "instant",
  input: z.object({}),
  dedup: "none",
  event: z
    .object({
      conversationId: z.string(),
      taskId: z.string(),
    })
    .passthrough(),
  maxAttempts: 3,
  run: async ({ event }) => {
    // `event` is narrowed by the first test: a truthy `event?.taskId` cannot
    // come from an absent `event`, so the second read needs no optional chain.
    if (!event?.taskId || !event.conversationId) return;

    const [pending] = await db
      .select()
      .from(_improvePendingGroups)
      .where(eq(_improvePendingGroups.taskId, event.taskId))
      .limit(1);

    if (!pending) return;

    await db
      .delete(_improvePendingGroups)
      .where(eq(_improvePendingGroups.taskId, event.taskId));

    await addMemberToGroup(pending.groupId, event.conversationId);
  },
});
