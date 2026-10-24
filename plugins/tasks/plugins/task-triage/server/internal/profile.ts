import { z } from "zod";
import { defineScratchProfile } from "@plugins/conversations/plugins/workspace/server";

/** The `tasks.triage` scratch profile's id. */
export const TRIAGE_PROFILE_ID = "tasks.triage";

/** The MCP tool a triage agent submits its read with. */
export const SUBMIT_TRIAGE_TOOL = "task_submit_triage";

/**
 * What the profile is launched with (the workspace spec's `input`): the task
 * it triages — so a submission can only ever fill that task's read — and the
 * main checkout it reads (resolved by the dispatcher, since `instructions` is
 * synchronous).
 */
export const TriageProfileInputSchema = z.object({
  taskId: z.string().min(1),
  mainRoot: z.string().min(1),
});
export type TriageProfileInput = z.infer<typeof TriageProfileInputSchema>;

/** The agent's CLAUDE.md: its role, what it may read, and the tool contract. */
export function triageInstructions({
  taskId,
  mainRoot,
}: TriageProfileInput): string {
  return `# Task triage

You triage ONE task of the Singularity repository — task \`${taskId}\`, quoted in your first message — so a person can decide whether, when and how an agent works on it.

## What you can do

- **Read only.** The repository's main checkout, at its latest commit, is \`${mainRoot}\`. Read it with Read, Grep and Glob, always by absolute path under it. Your working directory is an empty scratch directory: nothing about the task is in it.
- Editing, writing files and running commands are denied (Edit, Write, NotebookEdit, Bash). Do not try to work around it: everything you need is in the code and in your first message (it lists the commits on main since the task was filed).
- Never change the task, file tasks, or start agents. You report; the person decides.

## Reporting

1. When your read is ready, call \`${SUBMIT_TRIAGE_TOOL}\` with it — the whole record (verdict, priority, type, risk, context, question and answers, areas). It is shown on the task's Triage card at once.
2. Write two lines: your verdict and priority, and the one reason that decided them.
3. Call \`exit_clean\`. The conversation closes; the person can resume it later to ask you about your read.

If the person resumes this conversation with a follow-up that changes your read ("could this be a should instead?"), call \`${SUBMIT_TRIAGE_TOOL}\` again with the WHOLE updated record — it replaces the previous one — then answer in two lines and call \`exit_clean\` again. If it changes nothing, just answer.

If you cannot triage the task at all (it names nothing you can find, or it is not a software task), still submit your best read with the verdict that fits (usually \`decide\`, with your question), and say why in \`context\`. Use \`flag_raise\` only for a problem with this workspace itself.
`;
}

/**
 * The triage agent's workspace: an empty scratch directory whose CLAUDE.md is
 * {@link triageInstructions}. Read-only by `deny` alone — conversations run in
 * `bypassPermissions`, where an `allow` scope means nothing. It sees only the
 * submit tool, `exit_clean` (closing the conversation once delivered, so its
 * run task derives done) and `flag_raise`.
 */
export const triageProfile = defineScratchProfile({
  id: TRIAGE_PROFILE_ID,
  label: "Task triage",
  description:
    "Task triage: a read-only look at one task against the main checkout's code — verdict, MoSCoW priority, type, risk and context — submitted to the task's Triage card.",
  inputSchema: TriageProfileInputSchema,
  instructions: triageInstructions,
  mcpTools: [SUBMIT_TRIAGE_TOOL, "exit_clean", "flag_raise"],
  permissions: { deny: ["Edit", "Write", "NotebookEdit", "Bash"] },
});
