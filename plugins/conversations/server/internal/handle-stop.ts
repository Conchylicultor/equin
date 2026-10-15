import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { stopConversation } from "../../core/endpoints";
import { stopTurn } from "./turns";

export const handleStop = implement(stopConversation, async ({ params }) => {
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
});
