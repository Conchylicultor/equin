import { liveCollection } from "@plugins/network/plugins/live/core";
import { pendingQuestionsEntityRef } from "./entity";

// The OPEN held questions (the server's base `where state = 'open'`), read per
// conversation: answering, releasing or abandoning one is a membership exit.
// The CLI asks one question call at a time, so a conversation holds at most
// one; the small window is a bound, not a page size anyone scrolls.
export const pendingQuestions = liveCollection("question-relay.pending", {
  from: pendingQuestionsEntityRef,
  pick: ["conversationId"],
  carry: { pick: ["toolUseId", "questions", "createdAt"] },
  id: "toolUseId",
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "asc"]], limit: 5 },
  maxLimit: 20,
});
