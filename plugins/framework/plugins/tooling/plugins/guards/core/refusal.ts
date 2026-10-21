import { parseShell } from "./parse-shell";
import type { ToolMatcher } from "./types";
import {
  REFUSAL_HEADER,
  joinRefusal,
} from "@plugins/framework/plugins/tooling/plugins/guards/plugins/refusal-format/core";

/**
 * The first lines of EVERY guard denial: what did not happen because of it.
 *
 * A guard's own message says why the call was refused. It seldom says that
 * NOTHING in the call ran, and an agent that misses that goes on as though the
 * rest of it had. Measured: a Bash call that edited a file with an inline
 * `python3` heredoc and then ran `./singularity check` was denied by
 * `background-ops` over the check. The edit never happened, and the agent went
 * on to build, deploy and report a fix that was never on disk.
 *
 * So the runner puts this in front of every denial rather than leaving each
 * guard to remember it. It is keyed by tool, not by guard: what "did not run"
 * means depends on the tool, and `Record<ToolMatcher, …>` makes a new tool
 * matcher a tsc error until it says what did not happen.
 */
const NOT_DONE: Record<
  ToolMatcher,
  (input: Record<string, unknown>) => string
> = {
  Bash: (input) => bashNotRun(stringField(input, "command")),
  Write: (input) =>
    `The file was NOT written: ${stringField(input, "file_path") ?? "(no path)"} is unchanged on disk.`,
  Edit: (input) =>
    `The edit was NOT applied: ${stringField(input, "file_path") ?? "(no path)"} is unchanged on disk.`,
  NotebookEdit: (input) =>
    `The notebook edit was NOT applied: ${stringField(input, "notebook_path") ?? stringField(input, "file_path") ?? "(no path)"} is unchanged on disk.`,
  Read: (input) =>
    `The file was NOT read: ${stringField(input, "file_path") ?? "(no path)"}. You have not seen its contents.`,
  Agent: () =>
    "No agent was launched. Nothing it would have done has happened.",
};

function stringField(
  input: Record<string, unknown>,
  key: string,
): string | undefined {
  const v = input[key];
  return typeof v === "string" && v ? v : undefined;
}

function bashNotRun(command: string | undefined): string {
  const effects =
    "Any file edits, writes, installs or other side effects in it did NOT happen, so do not go on as if they had. Re-run the parts you still need as their own call.";
  if (!command) return `No part of the command was executed. ${effects}`;
  const count = parseShell(command).calls.length;
  if (count <= 1) return `The command was not executed at all. ${effects}`;
  return `None of its ${count} sub-commands was executed. ${effects}`;
}

/** `reason` with the what-did-not-happen banner in front of it. */
export function withRefusalBanner(
  tool: string,
  input: Record<string, unknown>,
  reason: string,
): string {
  const notDone = (NOT_DONE as Record<string, (typeof NOT_DONE)[ToolMatcher]>)[
    tool
  ];
  const lines = notDone
    ? `${REFUSAL_HEADER}\n${notDone(input)}`
    : `${REFUSAL_HEADER} None of its effects happened.`;
  return joinRefusal(lines, reason);
}
