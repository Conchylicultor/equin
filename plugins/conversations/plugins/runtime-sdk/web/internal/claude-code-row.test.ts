import { describe, expect, test } from "bun:test";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { ClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import { NO_CLAUDE_ACCOUNTS } from "@plugins/infra/plugins/claude-cli/plugins/accounts/core";
import type { ClaudeUsage } from "../../core";
import {
  agentsPhrase,
  claudeCodeRowVerdict,
  type ClaudeCodeRowInputs,
} from "./claude-code-row";

const refetch = () => Promise.resolve();
const sdk = { sdkVersion: "0.3.303", cliVersion: "2.1.303" };
const none = { here: 0, elsewhere: [] };
const NOW = 1_800_000_000_000;
const noUsage: ClaudeCodeRowInputs["usage"] = { byAccount: {} };
const OK: HealthStatus = { state: "ok", summary: "Signed in · v2.1.303" };
const loaded = (
  claude: ClaudeCodeStatus,
  agents: ClaudeCodeRowInputs["agents"] = none,
  usage: ClaudeCodeRowInputs["usage"] = noUsage,
  stopped: ClaudeCodeRowInputs["stopped"] = [],
): ResourceResult<ClaudeCodeRowInputs> => ({
  status: "ready",
  data: { claude, sdk, agents, usage, accounts: NO_CLAUDE_ACCOUNTS, stopped },
  refetch,
});
const ready = (
  version: string,
  agents = none,
  usage: ClaudeCodeRowInputs["usage"] = noUsage,
) =>
  loaded(
    { kind: "ready", version, authMethod: null, email: null },
    agents,
    usage,
  );

describe("claudeCodeRowVerdict", () => {
  test("same major.minor is ok, whatever the patch, with the agents", () => {
    expect(
      claudeCodeRowVerdict(
        OK,
        ready("2.1.999", { here: 3, elsewhere: [] }),
        NOW,
      ),
    ).toEqual({ state: "ok", summary: "v2.1.999 · 3 agents here" });
  });

  test("another minor is attention", () => {
    expect(claudeCodeRowVerdict(OK, ready("2.2.0"), NOW)).toEqual({
      state: "attention",
      summary: "v2.2.0 · the Agent SDK expects v2.1.303",
    });
  });

  test("Claude Code's own verdict wins when it is not ok", () => {
    const missing: HealthStatus = { state: "critical", summary: "missing" };
    expect(claudeCodeRowVerdict(missing, ready("2.2.0"), NOW)).toBe(missing);
    const checking: HealthStatus = { state: "unknown" };
    expect(claudeCodeRowVerdict(checking, ready("2.1.1"), NOW)).toBe(checking);
  });

  test("not known yet is unknown, never ok", () => {
    expect(
      claudeCodeRowVerdict(OK, { status: "loading", refetch }, NOW),
    ).toEqual({
      state: "unknown",
    });
  });

  test("no computer to read from is not-applicable, with why", () => {
    expect(
      claudeCodeRowVerdict(
        OK,
        { status: "unavailable", message: "Not here." },
        NOW,
      ),
    ).toEqual({ state: "not-applicable", summary: "Not here." });
  });
});

describe("usage limits", () => {
  const reading = (session: number, week: number): ClaudeUsage => ({
    observedAt: NOW - 60_000,
    session: { utilization: session, resetsAt: NOW + 90 * 60_000 },
    week: { utilization: week, resetsAt: NOW + 3 * 86_400_000 },
  });
  const usage = (
    session: number,
    week: number,
  ): ClaudeCodeRowInputs["usage"] => ({
    byAccount: { system: reading(session, week) },
  });

  test("under the limits is ok", () => {
    expect(
      claudeCodeRowVerdict(OK, ready("2.1.1", none, usage(0.9, 0.5)), NOW)
        .state,
    ).toBe("ok");
  });

  test("a reached limit is attention, with when it resets", () => {
    expect(
      claudeCodeRowVerdict(OK, ready("2.1.1", none, usage(1, 0.5)), NOW),
    ).toEqual({
      state: "attention",
      summary: "Session usage limit reached · resets in 1 h 30 m",
    });
  });

  test("another account's reached limit is not the active one's", () => {
    expect(
      claudeCodeRowVerdict(
        OK,
        ready("2.1.1", none, { byAccount: { work: reading(1, 1) } }),
        NOW,
      ).state,
    ).toBe("ok");
  });

  test("a limit that has since reset is not reached", () => {
    expect(
      claudeCodeRowVerdict(
        OK,
        ready("2.1.1", none, usage(1, 0.5)),
        NOW + 2 * 3_600_000,
      ).state,
    ).toBe("ok");
  });
});

describe("agentsPhrase", () => {
  test("conversations stopped at a usage limit are attention", () => {
    const signedIn: ClaudeCodeStatus = {
      kind: "ready",
      version: "2.1.303",
      authMethod: null,
      email: null,
    };
    const stopped = [
      {
        id: "conv-1",
        title: "Fix it",
        status: "waiting",
        account: "acct-a",
        limitHitAt: new Date(NOW),
      },
    ] as const satisfies ClaudeCodeRowInputs["stopped"];
    expect(
      claudeCodeRowVerdict(OK, loaded(signedIn, none, noUsage, stopped), NOW),
    ).toEqual({
      state: "attention",
      summary: "1 conversation stopped at a usage limit",
    });
  });

  test("none here, one here", () => {
    expect(agentsPhrase(none)).toBe("no agents here");
    expect(agentsPhrase({ here: 1, elsewhere: [] })).toBe("1 agent here");
  });

  test("sums the other namespaces", () => {
    expect(
      agentsPhrase({
        here: 2,
        elsewhere: [
          { namespace: "att-1", running: 2 },
          { namespace: "att-2", running: 1 },
        ],
      }),
    ).toBe("2 agents here · 3 in other worktrees");
  });
});
