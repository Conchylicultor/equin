import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { deleteConversation } from "@plugins/conversations/server";
import {
  getConversation,
  dropTaskTreeIfNoActiveSibling,
  markConversationClosed,
} from "@plugins/tasks/plugins/tasks-core/server";
import { dropDependents } from "../../shared/endpoints";

export const handleDropDependents = implement(dropDependents, async ({ params }) => {
  const { id } = params;

  const conversation = await getConversation(id);
  if (!conversation) {
    throw new HttpError(404, "Conversation not found");
  }

    // Closing one conversation never drops a task another conversation is
    // still working on — nor, with it, that task's dependents.
    const result = await dropTaskTreeIfNoActiveSibling(conversation);

  await markConversationClosed(id);
  await deleteConversation(id);

    return result;
  },
);
