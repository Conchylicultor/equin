/**
 * The environment variable a PreToolUse guard exports into a Bash command,
 * naming the tool call that runs it (see `guards/e2e-tool-use-id`). Claude
 * Code hands a command no identity of its own call; this is how what the
 * command leaves behind (an e2e recording) can be filed under the transcript
 * row that shows it.
 */
export const TOOL_USE_ID_ENV = "SINGULARITY_TOOL_USE_ID";

/** A tool-use id as Claude Code mints them — also a safe path segment and shell word. */
export const TOOL_USE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The tool call a process was launched by, or `null` when no guard stamped one
 * (a human at a terminal) or the value is not a tool-use id. Takes the
 * environment as data: the caller names its own process.
 */
export function toolUseIdFrom(
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const id = env[TOOL_USE_ID_ENV];
  return id !== undefined && TOOL_USE_ID_RE.test(id) ? id : null;
}
