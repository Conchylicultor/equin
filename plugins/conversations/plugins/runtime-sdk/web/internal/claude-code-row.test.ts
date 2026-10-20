import { describe, expect, test } from "bun:test";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import type { HealthStatus } from "@plugins/shell/plugins/health-report/web";
import type { ClaudeCodeStatus } from "@plugins/infra/plugins/claude-cli/plugins/availability/core";
import {
  agentsPhrase,
  claudeCodeRowVerdict,
  type ClaudeCodeRowInputs,
} from "./claude-code-row";

const refetch = () => Promise.resolve();
const sdk = { sdkVersion: "0.3.303", cliVersion: "2.1.303" };
const none = { here: 0, elsewhere: [] };
const OK: HealthStatus = { state: "ok", summary: "Signed in · v2.1.303" };
const loaded = (
  claude: ClaudeCodeStatus,
  agents: ClaudeCodeRowInputs["agents"] = none,
): ResourceResult<ClaudeCodeRowInputs> => ({
  status: "ready",
  data: { claude, sdk, agents },
  refetch,
});
const ready = (version: string, agents = none) =>
  loaded({ kind: "ready", version, authMethod: null, email: null }, agents);

describe("claudeCodeRowVerdict", () => {
  test("same major.minor is ok, whatever the patch, with the agents", () => {
    expect(
      claudeCodeRowVerdict(OK, ready("2.1.999", { here: 3, elsewhere: [] })),
    ).toEqual({ state: "ok", summary: "v2.1.999 · 3 agents here" });
  });

  test("another minor is attention", () => {
    expect(claudeCodeRowVerdict(OK, ready("2.2.0"))).toEqual({
      state: "attention",
      summary: "v2.2.0 · the Agent SDK expects v2.1.303",
    });
  });

  test("Claude Code's own verdict wins when it is not ok", () => {
    const missing: HealthStatus = { state: "critical", summary: "missing" };
    expect(claudeCodeRowVerdict(missing, ready("2.2.0"))).toBe(missing);
    const checking: HealthStatus = { state: "unknown" };
    expect(claudeCodeRowVerdict(checking, ready("2.1.1"))).toBe(checking);
  });

  test("not known yet is unknown, never ok", () => {
    expect(claudeCodeRowVerdict(OK, { status: "loading", refetch })).toEqual({
      state: "unknown",
    });
  });

  test("no computer to read from is not-applicable, with why", () => {
    expect(
      claudeCodeRowVerdict(OK, { status: "unavailable", message: "Not here." }),
    ).toEqual({ state: "not-applicable", summary: "Not here." });
  });
});

describe("agentsPhrase", () => {
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
