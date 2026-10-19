import { HttpError, implement } from "@plugins/infra/plugins/endpoints/server";
import { requestStatusReconcile } from "@plugins/conversations/server";
import {
  abandonRelayQuestion,
  answerRelayQuestion,
  AWAIT_HOLD_MS,
  awaitRelayQuestion,
  registerRelayQuestion,
  releaseRelayQuestion,
} from "../../core/endpoints";
import { toCliAnswer } from "./answer";
import {
  readOpenQuestions,
  readResolution,
  registerQuestion,
  resolveQuestion,
} from "./store";
import { waitForQuestion, wakeQuestion } from "./waiters";
import { notifyQuestionResolved, type ResolvedQuestion } from "./resolved";

export const handleRegister = implement(
  registerRelayQuestion,
  async ({ params, body }) => {
    const resolution = await registerQuestion(params.id, body);
    // The touch hook woke the reconciler too, possibly before this row
    // existed; this wake reads it.
    requestStatusReconcile([params.id]);
    return resolution;
  },
);

export const handleAwait = implement(
  awaitRelayQuestion,
  async ({ params, req }) => {
    // Registered before the read, so a write landing in between still wakes it.
    const wait = waitForQuestion(params.toolUseId, AWAIT_HOLD_MS, req.signal);
    const first = await readResolution(params.id, params.toolUseId).catch(
      (err: unknown) => {
        wait.cancel();
        throw err;
      },
    );
    if (first.state !== "open") {
      wait.cancel();
      return first;
    }
    await wait.done;
    return readResolution(params.id, params.toolUseId);
  },
);

async function settle(
  conversationId: string,
  toolUseId: string,
  resolution: ResolvedQuestion["resolution"],
): Promise<void> {
  await resolveQuestion(
    conversationId,
    toolUseId,
    resolution.state,
    resolution.state === "answered" ? resolution.answer : null,
  );
  wakeQuestion(toolUseId);
  requestStatusReconcile([conversationId]);
  await notifyQuestionResolved({ conversationId, toolUseId, resolution });
}

export const handleAnswer = implement(
  answerRelayQuestion,
  async ({ params, body }) => {
    const row = await readOpenQuestions(params.id, params.toolUseId);
    const checked = toCliAnswer(row.questions, body);
    if (!checked.ok) throw new HttpError(400, checked.error);
    await settle(params.id, params.toolUseId, {
      state: "answered",
      answer: checked.answer,
    });
  },
);

export const handleRelease = implement(releaseRelayQuestion, ({ params }) =>
  settle(params.id, params.toolUseId, { state: "released" }),
);

export const handleAbandon = implement(abandonRelayQuestion, ({ params }) =>
  settle(params.id, params.toolUseId, { state: "abandoned" }),
);
