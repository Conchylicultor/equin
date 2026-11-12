import { SYSTEM_ACCOUNT_ID } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import {
  claudeSessionEnv,
  readClaudeInitialize,
} from "@plugins/infra/plugins/claude-cli/plugins/sdk/server";
import { statusOfInitialize, type ClaudeCodeStatus } from "../../core";

/** CLI start-up plus its `initialize` answer; a ceiling, not an estimate. */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * Ask the machine, now: is Claude Code signed in?
 *
 * One Agent SDK session on the computer's own login (the system account),
 * under the host facts alone — the account the status is about — that reads
 * its `initialize` answer and closes. Never throws for a Claude Code problem:
 * every way the answer can come out is an arm of {@link ClaudeCodeStatus}.
 */
export async function probeClaudeCode(): Promise<ClaudeCodeStatus> {
  try {
    return statusOfInitialize(
      await readClaudeInitialize({
        env: await claudeSessionEnv(SYSTEM_ACCOUNT_ID),
        cwd: "/tmp",
        timeoutMs: PROBE_TIMEOUT_MS,
      }),
    );
  } catch (err) {
    // The check itself failed (timed out, the CLI crashed, the SDK's bundled
    // build is not installed): not a verdict.
    if (!(err instanceof Error)) throw err;
    return {
      kind: "unreadable",
      error: `Claude Code's initialize failed: ${err.message.slice(0, 300)}`,
    };
  }
}
