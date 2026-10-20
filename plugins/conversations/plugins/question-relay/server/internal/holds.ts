import {
  QuestionHolds,
  type QuestionHold,
} from "@plugins/conversations/server";
import { abandonDeadHolds, isPidAlive, latestHolds } from "./store";

// The relay as a question-hold source for the status reconciler: a
// conversation's LATEST held question decides. `open` with a live holder is a
// question waiting; an open row whose holder died is absent here and retired by
// `reap`.
export const relayQuestionHolds = QuestionHolds.define({
  async read(ids) {
    const holds = new Map<string, QuestionHold>();
    for (const row of await latestHolds(ids)) {
      if (row.state === "open" && isPidAlive(row.relayPid)) {
        holds.set(row.conversationId, "open");
      }
    }
    return holds;
  },
  async reap(ids) {
    await abandonDeadHolds(ids);
  },
});
