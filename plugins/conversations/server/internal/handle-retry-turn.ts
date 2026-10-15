import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { retryConversationTurn } from "../../core/endpoints";
import { retryTurn } from "./turns";

// Retry a `failed` / `unverified` ledger row: type it again, as it was typed.
// Any other state is a 409 — a settled turn reached the agent, and a pending
// one is still on its way.
export const handleRetryTurn = implement(
  retryConversationTurn,
  async ({ params }) => {
    const outcome = await retryTurn(params.id, params.turnId);
    if (outcome.kind === "not-found") throw new HttpError(404, "Not found");
    if (outcome.kind === "not-retryable") {
      throw new HttpError(
        409,
        `Turn ${params.turnId} is ${outcome.turn.state}, not failed or unverified`,
      );
    }
    return { turnId: outcome.turn.id, state: outcome.turn.state };
  },
);
