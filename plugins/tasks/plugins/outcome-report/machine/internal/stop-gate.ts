import { StopGate } from "@plugins/conversations/plugins/stop-gate/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import { grantOf } from "@plugins/tasks/plugins/orchestration/plugins/mandate/server";
import { reportRequired } from "@plugins/tasks/plugins/outcome-report/plugins/capability/core";
import { taskOutcomeReports } from "../../server/internal/tables";
import { OUTCOME_REPORT_TOOL } from "./capability";

/** A conversation whose mandate requires a report may not stop until it has
 * submitted one for its task (any report by THIS conversation counts). */
export const reportStopGate = StopGate({
  id: "outcome-report",
  async check(conversationId) {
    if ((await grantOf(reportRequired, conversationId)) === null)
      return { kind: "allow" };
    const conversation = await getConversation(conversationId);
    if (conversation === null) return { kind: "allow" };
    const report = await taskOutcomeReports.get(conversation.taskId);
    if (report?.conversationId === conversationId) return { kind: "allow" };
    return {
      kind: "block",
      reason: `Your mandate requires an outcome report and you have not submitted one: call \`${OUTCOME_REPORT_TOOL}\` before you stop.`,
    };
  },
});
