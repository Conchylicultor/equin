import { z } from "zod";
import { Mcp, type McpToolContext } from "@plugins/infra/plugins/mcp/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  automationOfTask,
  releaseLaunchedTask,
} from "@plugins/tasks/plugins/automations/server";
import { getAttemptWork } from "@plugins/tasks/plugins/attempt-work/server";
import { standingOf } from "@plugins/tasks/plugins/attempt-work/core";
import { recordNotification } from "@plugins/shell/plugins/notifications/server";
import { conversationRoute } from "@plugins/conversations/core";
import { agentManagerApp } from "@plugins/apps/plugins/agent-manager/plugins/shell/core";
import { taskOutcomeReports } from "../../server/internal/tables";

const TOOL = "submit_outcome_report";

/**
 * Whether this conversation's task was filed or launched by an automation —
 * the only conversations that end with an outcome report. Two primary-key
 * reads, run on every MCP request of every conversation (the `when` gate), so
 * nothing heavier belongs here.
 */
async function isAutomationConversation({
  conversationId,
}: McpToolContext): Promise<boolean> {
  const conversation = await getConversation(conversationId);
  if (conversation === null) return false;
  return (await automationOfTask(conversation.taskId)) !== null;
}

export const submitOutcomeReportTool = Mcp.tool({
  name: TOOL,
  when: isAutomationConversation,
  description: `Submit the outcome report for this task — the last thing you do. The user reads it later, away from the code and without its context, so write for someone who has never seen this part of the codebase. Cover, in short markdown sections:

- **Problem** — what was wrong or missing, and why we care.
- **Before → after** — the mental model before the change and after it.
- **What changed** — the change itself, in plain words (files only where they help).
- **Caveats** — anything you ran into, left out, or are unsure about.

If the work needs ONE decision from the user (a design choice, a risky change you did not push), put it in \`question\` with up to six short one-click \`answers\`; the user's choice arrives as your next message. Otherwise make the call yourself and leave \`question\` out.

Calling it again replaces the earlier report. Do not close the conversation (no \`exit_clean\`): it stays open for the user to review.`,
  inputSchema: {
    body: z
      .string()
      .trim()
      .min(1)
      .describe(
        "The report, in markdown: problem and why we care, before → after, what changed, caveats.",
      ),
    question: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("One decision the user must make. Omit when there is none."),
    answers: z
      .array(z.string().trim().min(1).max(60))
      .max(6)
      .optional()
      .describe(
        'Short labels for one-click answers to `question` (e.g. ["Push it", "Leave it"]). Requires `question`.',
      ),
  },
  async handler({ body, question, answers }, { conversationId }) {
    if (answers !== undefined && answers.length > 0 && question === undefined) {
      throw new Error("`answers` needs a `question` to answer.");
    }
    const conversation = await getConversation(conversationId);
    if (conversation === null) {
      throw new Error(`Conversation ${conversationId} not found.`);
    }
    const { taskId } = conversation;
    // Measured from git at submit time (attempt-work), not from the pushes
    // ledger: "branch built, waiting for its push" is a standing of its own.
    const work = await getAttemptWork(conversation.attemptId);
    if (!work.resolved) {
      throw new Error(
        `Could not measure this attempt's work against main (${work.reason}); try again.`,
      );
    }
    const standing = standingOf(work.value);

    await taskOutcomeReports.upsert(taskId, {
      conversationId,
      body,
      standing,
      question: question ?? null,
      answers: answers ?? [],
      submittedAt: new Date(),
    });
    // Frees the automation slot this task held and wakes its automation.
    await releaseLaunchedTask(taskId);

    if (question !== undefined) {
      await recordNotification({
        type: "outcome-report-question",
        variant: "info",
        title: `Your call: ${conversation.taskTitle}`,
        description: question,
        linkTo: conversationRoute.link(agentManagerApp, {
          convId: conversationId,
        }),
        metadata: { taskId, conversationId },
        // One row per task; a new question re-alerts.
        dedupeKey: `outcome-report-question:${taskId}`,
        resurfaceAfterMs: 0,
      });
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            ok: true,
            standing,
            next: "Report saved. End your turn; do not close the conversation.",
          }),
        },
      ],
    };
  },
});

export const outcomeReportInstructions = Mcp.instructions({
  id: "outcome-report",
  async render(ctx) {
    if (!(await isAutomationConversation(ctx))) return null;
    return `## Outcome report

This task was started by an automation; the user is not watching. Never ask questions mid-way — decide, or stop. Always finish by calling \`${TOOL}\` (see its description), then end your turn. Never call \`exit_clean\`: the conversation stays open for review.`;
  },
});
