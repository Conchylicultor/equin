import { eq } from "drizzle-orm";
import { serveCollection } from "@plugins/network/plugins/live/server";
import { pendingQuestions } from "../../core/resources";
import { _pendingQuestions, pendingQuestionsEntity } from "./tables";

// The collection IS the open holds: answering, releasing or abandoning one is a
// membership exit, so the web's card goes away with the write that ended it.
export const pendingQuestionsServed = serveCollection(pendingQuestions, {
  from: pendingQuestionsEntity,
  where: eq(_pendingQuestions.state, "open"),
});
