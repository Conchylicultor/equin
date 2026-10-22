import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { resumeConversation } from "@plugins/conversations/server";
import { resumeConversationEndpoint } from "../../core/endpoints";

export const handleResume = implementMachine(
  resumeConversationEndpoint,
  async ({ params }) => {
    try {
      await resumeConversation(params.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HttpError(409, msg);
    }
  },
);
