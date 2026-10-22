import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { withdrawConversationTurn } from "../../core/endpoints";
import { withdrawTurn } from "../../server/internal/turns";

// Withdraw a `failed` / `unverified` ledger row: the user put its text back in
// the draft. Any other state is a 409 — a settled turn reached the agent, and a
// pending one is still on its way.
export const handleWithdrawTurn = implementMachine(
  withdrawConversationTurn,
  async ({ params }) => {
    const outcome = await withdrawTurn(params.id, params.turnId);
    if (outcome.kind === "not-found") throw new HttpError(404, "Not found");
    if (outcome.kind === "not-withdrawable") {
      throw new HttpError(
        409,
        `Turn ${params.turnId} is ${outcome.turn.state}, not failed or unverified`,
      );
    }
    return { turnId: outcome.turn.id, state: outcome.turn.state };
  },
);
