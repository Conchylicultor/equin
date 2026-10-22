import { requestStatusReconcile } from "@plugins/conversations/server";
import { RelayQuestionsSchema, type RelayResolution } from "../../core/schemas";
import {
  abandonIfOpen,
  registerQuestion as upsertQuestion,
} from "../../server/internal/store";

// The relay for a runtime that holds the AskUserQuestion call in-process (the
// sdk runtime's `canUseTool`): a `pending_questions` row, the web form and the
// question hold — registered, answered (through `onQuestionResolved`) and
// retired by direct calls.

/**
 * Hold `toolUseId`'s question for the web form, its liveness tied to `pid`
 * (the process parked on it). Idempotent: a re-registration answers where the
 * question already stands, so a holder that reconnects learns an answer it
 * missed.
 */
export async function holdQuestion(
  conversationId: string,
  question: { toolUseId: string; questions: unknown; pid: number },
): Promise<RelayResolution> {
  const resolution = await upsertQuestion(conversationId, {
    toolUseId: question.toolUseId,
    // The tool input as the model wrote it: parsed (defaults filled in) here —
    // a malformed one throws.
    questions: RelayQuestionsSchema.parse(question.questions),
    pid: question.pid,
  });
  requestStatusReconcile([conversationId]);
  return resolution;
}

/** The holder stopped waiting on the question without the web answering it. */
export async function retireQuestion(
  conversationId: string,
  toolUseId: string,
): Promise<void> {
  if (await abandonIfOpen(conversationId, toolUseId)) {
    requestStatusReconcile([conversationId]);
  }
}
