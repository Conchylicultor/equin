import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { stopConversation } from "../../core/endpoints";
import { stopTurn } from "../../server/internal/turns";

export const handleStop = implementMachine(
  stopConversation,
  async ({ params }) => {
    let rewindText: string | null;
    try {
      rewindText = await stopTurn(params.id);
    } catch (err) {
      if (err instanceof Error && err.message.includes("not found")) {
        throw new HttpError(404, "Not found");
      }
      throw err;
    }
    return { ok: true, rewindText };
  },
);
