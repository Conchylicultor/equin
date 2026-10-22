import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { deleteConversation } from "@plugins/conversations/server";
import {
  getConversation,
  markConversationClosed,
  updateTask,
} from "@plugins/tasks/plugins/tasks-core/server";
import { holdAndExit } from "../../shared/endpoints";

export const handleHoldAndExit = implementMachine(
  holdAndExit,
  async ({ params }) => {
    const conversation = await getConversation(params.id);
    if (!conversation) {
      throw new HttpError(404, "Conversation not found");
    }

    await updateTask(conversation.taskId, { hold: true });

    await markConversationClosed(params.id);
    await deleteConversation(params.id);
  },
);
