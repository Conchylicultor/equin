import type {
  ResourceUnavailable,
  ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { ClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import type { ClaudeAccounts } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import {
  limitReached,
  type AgentProcesses,
  type ClaudeUsageRead,
  type ErrorStoppedConversation,
} from "../../core";
import { formatResets, USAGE_WINDOWS } from "./claude-usage";

export interface ClaudeCodeRowInputs {
  /** The Claude Code the sdk runtime runs (the Agent SDK's bundled build). */
  claude: ClaudeCodeStatus;
  /** The agent processes running here and in every other namespace. */
  agents: AgentProcesses;
  /** Each Claude account's usage limits, as the agents last reported them. */
  usage: ClaudeUsageRead;
  /** The Claude accounts and the one new agents launch on. */
  accounts: ClaudeAccounts;
  /** The conversations whose agent's turn an API error stopped (latest first). */
  stopped: readonly ErrorStoppedConversation[];
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** The other namespaces' agents, summed. */
export function agentsElsewhere(agents: AgentProcesses): number {
  return agents.elsewhere.reduce((sum, e) => sum + e.running, 0);
}

/** `3 agents here · 2 in other worktrees` / `no agents here`. */
export function agentsPhrase(agents: AgentProcesses): string {
  const here =
    agents.here === 0
      ? "no agents here"
      : `${plural(agents.here, "agent")} here`;
  const elsewhere = agentsElsewhere(agents);
  return elsewhere > 0 ? `${here} · ${elsewhere} in other worktrees` : here;
}

/**
 * The health report's Claude Code row: Claude Code itself (the build the
 * Agent SDK ships) and the agent processes running.
 *
 * - Claude Code signed out, unreadable or still loading → its own verdict
 *   (`cli`), unchanged: nothing below it can be vouched for.
 * - The active account's usage limit reached → `attention`: its agents wait
 *   until it resets (or run on another account).
 * - Conversations an API error stopped (a usage limit, a server error, a
 *   lost connection) → `attention`: they wait for a
 *   resume (the row's detail offers one).
 * - Otherwise `ok`, with the version and the agents running.
 *
 * The counts not known yet → `unknown`, never `ok`; under a
 * host without the computer → `not-applicable` with the sentence saying so:
 * nothing is wrong, there is just no computer to read.
 */
export function claudeCodeRowVerdict(
  cli: HealthStatus,
  result: ResourceResult<ClaudeCodeRowInputs> | ResourceUnavailable,
  now: number,
): HealthStatus {
  if (cli.state !== "ok") return cli;
  if (result.status === "unavailable") {
    return { state: "not-applicable", summary: result.message };
  }
  if (result.status === "loading") return { state: "unknown" };
  if (result.status === "error") {
    return {
      state: "unknown",
      summary:
        "Couldn't load the running agents, the Claude accounts or their usage limits",
    };
  }
  const { claude, agents, usage, accounts, stopped } = result.data;
  if (claude.kind !== "ready") return cli;
  const reached = limitReached(usage.byAccount[accounts.active], now);
  if (reached) {
    const { label } = USAGE_WINDOWS[reached.id];
    return {
      state: "attention",
      summary: `${label} usage limit reached · ${formatResets(reached.id, reached.resetsAt, now)}`,
    };
  }
  if (stopped.length > 0) {
    return {
      state: "attention",
      summary: `${plural(stopped.length, "conversation")} stopped by an API error`,
    };
  }
  return {
    state: "ok",
    summary: `v${claude.version} · ${agentsPhrase(agents)}`,
  };
}
