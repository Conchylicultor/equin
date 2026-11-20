import {
  setConversationTitleByUser,
  UnknownConversationError,
} from "@plugins/tasks/plugins/tasks-core/server";
import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { renameConversation } from "../../core";

export const handleRename = implement(
  renameConversation,
  async ({ params, body }) => {
    await setConversationTitleByUser(params.id, body.title).catch(
      (err: unknown) => {
        if (err instanceof UnknownConversationError) {
          throw new HttpError(404, err.message);
        }
        throw err;
      },
    );
  },
);
