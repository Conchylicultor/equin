import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { submitTurn } from "@plugins/conversations/server";
import { answerAskUserQuestion } from "../../shared/endpoints";

export const handleAnswer = implementMachine(
  answerAskUserQuestion,
  async ({ params, body }) => {
    // An `answer` ledger turn: the runtime withdraws any open question, then
    // sends the answers — atomic inside its answerPrompt() (see its contract).
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
