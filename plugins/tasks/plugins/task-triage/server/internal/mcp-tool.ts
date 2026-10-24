import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { workspaceOfConversation } from "@plugins/conversations/plugins/workspace/server";
import { recordScratchDelivery } from "@plugins/tasks/plugins/tasks-core/server";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import { TriageResultSchema } from "../../core";
import { wakeTriageDispatcher } from "./dispatch";
import {
  SUBMIT_TRIAGE_TOOL,
  TRIAGE_PROFILE_ID,
  TriageProfileInputSchema,
} from "./profile";
import { readTriagedTask, recordRead } from "./state";

/**
 * Store the triage agent's read on the task its workspace was launched for —
 * never a task the agent names, so a submission can only fill its own task's
 * card. Calling it again (a resumed follow-up) replaces the read. Records the
 * delivery on the conversation (idempotent per attempt), so its run task
 * derives done once the conversation closes, and wakes the dispatcher.
 */
export const submitTriageTool = Mcp.tool({
  name: SUBMIT_TRIAGE_TOOL,
  profiles: [TRIAGE_PROFILE_ID],
  description: `Submit your triage read of the task: it is shown on the task's Triage card at once, replacing any previous read. Pass the WHOLE record every time.

Once it succeeds, write two lines (your verdict and priority, and the one reason that decided them), then call \`exit_clean\`. If the person later resumes the conversation and your read changes, submit again.`,
  inputSchema: TriageResultSchema.shape,
  async handler(args, { conversationId }) {
    const ws = await workspaceOfConversation(conversationId);
    if (ws.spec.kind !== "scratch" || ws.spec.profile !== TRIAGE_PROFILE_ID) {
      throw new Error(
        `[task-triage] conversation ${conversationId} is not a ${TRIAGE_PROFILE_ID} workspace`,
      );
    }
    const { taskId, mainRoot } = TriageProfileInputSchema.parse(ws.spec.input);
    const task = await readTriagedTask(taskId);
    if (task === null) {
      throw new Error(`[task-triage] task ${taskId} no longer exists`);
    }
    const result = TriageResultSchema.parse(args);
    const mainSha = (
      await runGit(["rev-parse", "refs/heads/main"], mainRoot)
    ).trim();
    await recordRead({
      taskId,
      conversationId,
      result,
      task,
      mainSha,
      now: new Date(),
    });
    await recordScratchDelivery(conversationId, {
      summary: `Triaged ${taskId}: ${result.verdict}, ${result.priority}, ${result.taskType}, ${result.risk} risk.`,
    });
    await wakeTriageDispatcher();
    return {
      content: [
        {
          type: "text",
          text: `Saved: the Triage card of ${taskId} shows your read now. Write two lines (verdict and priority, and the one reason that decided them), then call exit_clean.`,
        },
      ],
    };
  },
});
