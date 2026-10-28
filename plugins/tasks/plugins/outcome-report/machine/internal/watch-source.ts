import { watchSource } from "@plugins/tasks/plugins/orchestration/plugins/watch/machine";
import { outcomeReportSubmitted } from "../../server/internal/tables-events";

/** A report reaches whoever watches its task: `reported`, or `asking` when it
 * waits on a decision. The summary is the whole report (and the question). */
export const outcomeReportWatchSource = watchSource({
  id: "outcome-report",
  on: outcomeReportSubmitted,
  toEvents: (p) => [
    {
      kind: p.question === null ? "reported" : "asking",
      taskId: p.taskId,
      actorConversationId: p.conversationId,
      summary:
        p.question === null
          ? `report (${p.standing}):\n${p.body}`
          : `asks: ${p.question}\nreport (${p.standing}):\n${p.body}`,
      payload: { standing: p.standing, question: p.question },
    },
  ],
});
