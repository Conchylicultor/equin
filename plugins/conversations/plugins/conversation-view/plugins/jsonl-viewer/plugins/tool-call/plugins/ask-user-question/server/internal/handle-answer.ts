import { implement, HttpError } from "@plugins/infra/plugins/endpoints/server";
import { submitTurn } from "@plugins/conversations/server";
import { answerAskUserQuestion } from "../../shared/endpoints";

export const handleAnswer = implement(
  answerAskUserQuestion,
  async ({ params, body }) => {
    // An `answer` ledger turn: the runtime dismisses the AskUserQuestion form,
    // waits for it to clear, then types the answers — all atomic inside its
    // answerPrompt() (see its contract).
    const outcome = await submitTurn(params.id, {
      id: body.turnId,
      kind: "answer",
      text: body.text,
      typedText: body.text,
    });
    if (outcome.kind === "not-found") throw new HttpError(404, "Not found");
    return { turnId: outcome.turn.id };
  },
);
