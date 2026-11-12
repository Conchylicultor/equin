import { db } from "@plugins/database/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  createQueueSection,
  deleteQueueSection,
  moveQueueSection,
  renameQueueSection,
} from "../../core";
import {
  createSection,
  deleteSection,
  moveSection,
  renameSection,
  type FiledConversation,
} from "./queue-ops";

export const handleCreateSection = implement(
  createQueueSection,
  async ({ body }) => {
    const { name, after, conversationId } = body;
    let conversation: FiledConversation | undefined;
    if (conversationId !== undefined) {
      const conv = await getConversation(conversationId);
      if (!conv) throw new HttpError(404, "Not found");
      conversation = { conversationId, taskId: conv.taskId };
    }
    const id = await db.transaction((tx) =>
      createSection(tx, { name, after, conversation }),
    );
    return { id };
  },
);

export const handleRenameSection = implement(
  renameQueueSection,
  async ({ body }) => {
    await db.transaction((tx) => renameSection(tx, body.id, body.name));
  },
);

export const handleMoveSection = implement(
  moveQueueSection,
  async ({ body }) => {
    await db.transaction((tx) => moveSection(tx, body));
  },
);

export const handleDeleteSection = implement(
  deleteQueueSection,
  async ({ body }) => {
    await db.transaction((tx) => deleteSection(tx, body.id));
  },
);
