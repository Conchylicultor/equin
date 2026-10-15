import { liveCollection } from "@plugins/network/plugins/live/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { RelayQuestionsSchema } from "./schemas";

// The OPEN held questions (the server's base `where state = 'open'`), read per
// conversation: answering, releasing or abandoning one is a membership exit.
// The CLI asks one question call at a time, so a conversation holds at most
// one; the small window is a bound, not a page size anyone scrolls.
export const pendingQuestions = liveCollection("question-relay.pending", {
  fields: { conversationId: textField({ label: "Conversation" }) },
  carry: {
    fields: {
      toolUseId: textField(),
      questions: jsonField({ schema: RelayQuestionsSchema, default: [] }),
      createdAt: dateField(),
    },
  },
  id: "toolUseId",
  sortable: ["createdAt"],
  default: { orderBy: [["createdAt", "asc"]], limit: 5 },
  maxLimit: 20,
});
