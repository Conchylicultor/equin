import type {
  ResourceUnavailable,
  ResourceResult,
} from "@plugins/primitives/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { ClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import {
  sameMajorMinor,
  type AgentProcesses,
  type ClaudeUsageRead,
} from "../../core";
import { formatResets, limitReached, USAGE_WINDOWS } from "./claude-usage";

export interface ClaudeCodeRowInputs {
  /** The system `claude` the sdk runtime runs. */
  claude: ClaudeCodeStatus;
  /** The installed Agent SDK and the CLI it was built for. */
  sdk: { sdkVersion: string; cliVersion: string };
  /** The agent processes running here and in every other namespace. */
  agents: AgentProcesses;
  /** The subscription's usage limits, as the agents last reported them. */
  usage: ClaudeUsageRead;
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
 * The health report's Claude Code row: Claude Code itself, the Agent SDK that
 * runs it, and the agent processes running.
 *
 * - Claude Code missing, signed out, unreadable or still loading → its own
 *   verdict (`cli`), unchanged: nothing below it can be vouched for.
 * - The system `claude` in another major.minor than the CLI the installed Agent
 *   SDK was built for → `attention`: the SDK's control protocol may have moved
 *   under it.
 * - A usage limit reached → `attention`: agents wait until it resets.
 * - Otherwise `ok`, with the version and the agents running.
 *
 * The versions and the count not known yet → `unknown`, never `ok`; under a
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
        "Couldn't load the Agent SDK version, the running agents or the usage limits",
    };
  }
  const { claude, sdk, agents, usage } = result.data;
  if (claude.kind !== "ready") return cli;
  if (!sameMajorMinor(claude.version, sdk.cliVersion)) {
    return {
      state: "attention",
      summary: `v${claude.version} · the Agent SDK expects v${sdk.cliVersion}`,
    };
  }
  const reached = limitReached(usage, now);
  if (reached) {
    const { label } = USAGE_WINDOWS[reached.id];
    return {
      state: "attention",
      summary: `${label} usage limit reached · ${formatResets(reached.id, reached.resetsAt, now)}`,
    };
  }
  return {
    state: "ok",
    summary: `v${claude.version} · ${agentsPhrase(agents)}`,
  };
}
