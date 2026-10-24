import { Investigate } from "@plugins/primitives/plugins/launch/plugins/investigate/web";
import { taskTriageReads, type TaskTriageRow } from "../../core";

/**
 * A failed triage run's Investigate action, in every list of triage reads: an
 * agent briefed on the run (its error verbatim, the conversation and run task
 * behind it) and where to dig. Re-run is the card's own answer to a one-off
 * failure; this is for a run that keeps failing.
 */
export const investigateTriageRuns = Investigate.Register<TaskTriageRow>({
  owner: taskTriageReads,
  failed: (row) => row.state === "failed",
  noun: "triage run",
  categoryId: "system",
  subject: (row) => ({ kind: "task-triage-failure", id: row.taskId }),
  description: () =>
    "Launch an agent briefed on this failed triage run — its error verbatim, the conversation that ran it, and where to dig.",
  brief: (row, userText) => {
    const extra = userText.trim();
    return [
      "## Investigate a failed triage run",
      "",
      `Triage of task \`${row.taskId}\` failed.`,
      "",
      "**The run**",
      "",
      `- requested: ${row.requestedAt.toISOString()}`,
      `- started: ${row.startedAt ? row.startedAt.toISOString() : "never started"}`,
      `- conversation: ${row.conversationId ? `\`${row.conversationId}\`` : "none (the launch itself failed)"}`,
      `- run task: ${row.runTaskId ? `\`${row.runTaskId}\`` : "none"}`,
      "",
      ...(row.error
        ? ["**The error**, verbatim:", "", "```", row.error, "```", ""]
        : ["The run recorded no error.", ""]),
      "**Where to dig**",
      "",
      `- the row: \`select * from tasks_ext_triage where parent_id = '${row.taskId}'\` via \`query_db\`;`,
      "- the run's conversation transcript, if it has one (did it call `task_submit_triage`? did the tool reject its input?);",
      "- the dispatcher, profile and submit tool live in `plugins/tasks/plugins/task-triage/server/internal/` (`dispatch.ts`, `profile.ts`, `mcp-tool.ts`, `jobs.ts`).",
      "",
      "Find the root cause and say what it is. Fix it if the fix is clearly in this repo.",
      ...(extra ? ["", "## What the user asked for", "", extra] : []),
    ].join("\n");
  },
});
