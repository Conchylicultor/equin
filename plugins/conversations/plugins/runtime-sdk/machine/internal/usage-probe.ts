import { tmpdir } from "node:os";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { claudeAccountToken } from "@plugins/infra/plugins/claude-cli/plugins/accounts/server";
import {
  onClaudeCodeProbed,
  requireClaudeBin,
} from "@plugins/infra/plugins/claude-cli/plugins/availability/server";
import { readClaudeAccounts } from "@plugins/infra/plugins/claude-cli/plugins/accounts/machine";
import { implementMachine } from "@plugins/infra/plugins/endpoints/machine";
import { pickHostEnv } from "@plugins/infra/plugins/launcher/core";
import { createInflight } from "@plugins/packages/plugins/inflight/core";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import {
  claudeUsageOfReply,
  refreshClaudeUsage,
  type ClaudeUsageRefresh,
} from "../../core";
import { writeClaudeUsageFile } from "./claude-usage";
import { claudeUsagePath } from "./paths";

// An account's usage limits read on demand, without an agent turn: one Agent
// SDK session that sends no prompt, asks Claude Code its `get_usage` control
// request (what `/usage` shows — no model call, nothing billed) and closes.
// ~1 s of CLI start-up. Recorded in the same per-account file the agents
// overwrite, so the meters, the account picker and auto-switch read it alike.

/** CLI start-up plus one HTTP read; a ceiling, not an estimate. */
const USAGE_READ_TIMEOUT_MS = 60_000;

async function readUsageReply(accountId: string): Promise<unknown> {
  // The system account (null) is Claude Code's own sign-in.
  const token = await claudeAccountToken(accountId);
  const abortController = new AbortController();
  const timeout = setTimeout(
    () => abortController.abort(),
    USAGE_READ_TIMEOUT_MS,
  );
  let release!: () => void;
  const released = new Promise<void>((resolve) => (release = resolve));
  // Streaming input that never yields: the session stays open for control
  // requests and no turn is ever sent.
  async function* noPrompt(): AsyncGenerator<never> {
    await released;
  }
  const session = query({
    prompt: noPrompt(),
    options: {
      cwd: tmpdir(),
      pathToClaudeCodeExecutable: requireClaudeBin(),
      // Same closed host environment as an agent's (the user's own overrides),
      // with only this account's token added.
      env: {
        ...pickHostEnv(process.env),
        ...(token ? { CLAUDE_CODE_OAUTH_TOKEN: token } : {}),
      },
      settingSources: [],
      strictMcpConfig: true,
      persistSession: false,
      abortController,
    },
  });
  try {
    return await session.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(
      { skipBehaviors: true },
    );
  } finally {
    clearTimeout(timeout);
    release();
    session.close();
  }
}

const inflight = createInflight();

/**
 * Read `accountId`'s limits now and, when there are some, overwrite its usage
 * file (the watch pushes `runtime-sdk.claude-usage`). Concurrent asks for one
 * account share one read.
 */
export function refreshClaudeUsageNow(
  accountId: string,
): Promise<ClaudeUsageRefresh> {
  return inflight.run(accountId, async () => {
    const observedAt = Date.now();
    const result = claudeUsageOfReply(
      await readUsageReply(accountId),
      observedAt,
    );
    if (result.kind === "read")
      writeClaudeUsageFile(claudeUsagePath(accountId), result.usage);
    return result;
  });
}

export const handleRefreshClaudeUsage = implementMachine(
  refreshClaudeUsage,
  ({ body }) => refreshClaudeUsageNow(body.accountId),
);

/**
 * Every fresh Claude Code probe — Check again, a launch's re-check, a sign-in
 * noticed — also re-reads the active account's limits: a `claude auth login`
 * as someone else changes whose limits the computer's own account has, and
 * announces nothing else. Push-based: it rides the probes the app already makes.
 */
let unsubscribe: (() => void) | null = null;

export function startUsageOnProbe(): void {
  unsubscribe ??= onClaudeCodeProbed((status) => {
    if (status.kind !== "ready") return;
    const accountId = readClaudeAccounts().active;
    void runTracked("runtime-sdk.usage-on-probe", async () => {
      try {
        await refreshClaudeUsageNow(accountId);
      } catch (err) {
        // Nobody awaits this read: a failure is reported, never swallowed.
        await recordReport({
          kind: "crash",
          source: "server-caught",
          message: `Reading Claude account "${accountId}"'s usage limits after a Claude Code probe failed: ${err instanceof Error ? err.message : String(err)}`,
          data: {
            errorType: "ClaudeUsageReadFailed",
            label: "runtime-sdk.usage",
          },
        });
      }
    });
  });
}

export function stopUsageOnProbe(): void {
  unsubscribe?.();
  unsubscribe = null;
}
