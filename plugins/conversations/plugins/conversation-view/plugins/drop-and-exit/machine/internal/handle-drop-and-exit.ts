import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { deleteConversation } from "@plugins/conversations/server";
import {
  getConversation,
  markConversationClosed,
} from "@plugins/tasks/plugins/tasks-core/server";
import { dropAndExit } from "../../core/endpoints";
import { dropTaskOnExit } from "../../server/internal/drop-task-on-exit";

export const handleDropAndExit = implementMachine(
  dropAndExit,
  async ({ params }) => {
    const { id } = params;

    const conversation = await getConversation(id);
    if (!conversation) {
      throw new HttpError(404, "Conversation not found");
    }

    // The user chose Drop from the exit menu: anything not yet in `main` drops.
    const dropped = await dropTaskOnExit(conversation, "unless-landed");

    await markConversationClosed(id);
    await deleteConversation(id);

    return { ok: true, dropped };
  },
);
