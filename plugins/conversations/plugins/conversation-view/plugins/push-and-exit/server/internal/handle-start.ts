import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { getConfig } from "@plugins/config_v2/server";
import { submitTurn } from "@plugins/conversations/server";
import { startPushAndExit } from "../../shared/endpoints";
import { pushAndExitConfig } from "../../shared/config";

// Inject the wrap-up prompt as a ledger turn of its own kind and return. The
// conversation's own status (working → waiting/done) is the single source of
// truth for the button state — no separate job row to track or tear down.
// Awaiting the submit only surfaces an immediate inject failure to the
// clicking tab as a toast; the ledger row carries the rest.
export const handleStart = implement(
  startPushAndExit,
  async ({ params, body }) => {
    const prompt = getConfig(pushAndExitConfig).prompt;
    const outcome = await submitTurn(params.id, {
      id: body.turnId,
      kind: "push-and-exit",
      text: prompt,
      typedText: prompt,
    });
    if (outcome.kind === "not-found") throw new HttpError(404, "Not found");
    return { turnId: outcome.turn.id };
  },
);
