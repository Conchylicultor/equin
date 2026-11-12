import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { fileQueue } from "../../core";
import { fileGroup } from "./queue-ops";

// File the conversation's task group into a section, or back to the Queue —
// see `fileGroup`.
export const handleFile = implement(fileQueue, async ({ body }) => {
  const { conversationId, section } = body;
  const conv = await getConversation(conversationId);
  if (!conv) throw new HttpError(404, "Not found");
  await db.transaction((tx) =>
    fileGroup(tx, { conversationId, taskId: conv.taskId }, section),
  );
});
