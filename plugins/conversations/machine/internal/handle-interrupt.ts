import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { interruptConversationTurn } from "../../core/endpoints";
import { interruptConversation } from "../../server/internal/runtime";

export const handleInterrupt = implementMachine(
  interruptConversationTurn,
  async ({ params }) => {
    try {
      await interruptConversation(params.id);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        throw new HttpError(404, "Not found");
      }
      throw err;
    }
    return { ok: true as const };
  },
);
