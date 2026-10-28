import type { Query, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { withDeadline } from "@plugins/packages/plugins/deadline/core";
import { claudeQuery, type ClaudeQueryInput } from "./session";

/** What a turn ends with: a success, or an error result carrying its reason. */
export type ClaudeTurnResult = SDKResultMessage;

/** A turn that ended without its result: timed out, or the CLI died before answering. */
export class ClaudeTurnError extends Error {
  constructor(
    message: string,
    readonly timedOut: boolean,
  ) {
    super(message);
    this.name = "ClaudeTurnError";
  }
}

/**
 * The result message a session ends with. The SDK throws once the CLI reports
 * an error result ("Claude Code returned an error result: …") — after it has
 * yielded that result, which carries the reason in full, so a thrown error
 * after a result is the result; one before any result is the failure.
 */
async function readResult(session: Query): Promise<SDKResultMessage> {
  let result: SDKResultMessage | undefined;
  try {
    for await (const message of session)
      if (message.type === "result") result = message;
  } catch (err) {
    if (result === undefined) throw err;
  }
  if (result === undefined)
    throw new ClaudeTurnError("Claude Code ended without a result", false);
  return result;
}

/**
 * One prompt, one result: a session on `input`'s account that runs `prompt`
 * to its result message and closes. `timeoutMs` is a real ceiling: past it the
 * session is aborted (the CLI killed) and the await rejects with a timed-out
 * {@link ClaudeTurnError} whether or not the SDK's stream ever settles.
 *
 * Returns the result whatever it says — success or an error result (a usage
 * limit, max turns) is the caller's to read; it throws only when there is no
 * result to read.
 */
export async function runClaudeTurn(
  input: Omit<ClaudeQueryInput, "prompt" | "options"> & {
    prompt: string;
    options: Omit<ClaudeQueryInput["options"], "abortController">;
    timeoutMs: number;
  },
): Promise<SDKResultMessage> {
  const abortController = new AbortController();
  const session = claudeQuery({
    env: input.env,
    bin: input.bin,
    prompt: input.prompt,
    options: { ...input.options, abortController },
  });
  try {
    return await withDeadline(readResult(session), input.timeoutMs, () => {
      abortController.abort();
      return new ClaudeTurnError(
        `Claude Code did not finish within ${input.timeoutMs}ms and was killed.`,
        true,
      );
    });
  } finally {
    session.close();
  }
}
