import { describe, expect, test } from "bun:test";
import type { StartedOp } from "./agent-ops";
import { agentMatches, decideStop, type LiveOp } from "./stop-guard";

const started = (op: string, cwd = "/r/worktrees/att-1"): StartedOp => ({
  agentId: "a1",
  op,
  cwd,
  at: Date.now(),
});
const live = (op: string, slug = "att-1"): LiveOp => ({ slug, op });

describe("decideStop", () => {
  test("an agent with no recorded op may stop", () => {
    expect(decideStop([], [live("build")], false).kind).toBe("allow");
  });

  test("an agent whose op has finished may stop", () => {
    expect(decideStop([started("build")], [], false).kind).toBe("allow");
  });

  test("an agent whose own op is still running is blocked", () => {
    const v = decideStop([started("build")], [live("build")], false);
    expect(v.kind).toBe("block");
    expect(v.kind === "block" && v.reason).toContain("./equin await build");
  });

  test("someone else's op in another checkout does not pin this agent", () => {
    // The parent's build, or another worktree's — the marker is live, but this
    // agent did not start anything there.
    const v = decideStop(
      [started("build", "/r/worktrees/att-1")],
      [live("build", "att-2")],
      false,
    );
    expect(v.kind).toBe("allow");
  });

  test("a different KIND running in the same checkout does not pin it either", () => {
    const v = decideStop([started("build")], [live("check")], false);
    expect(v.kind).toBe("allow");
  });

  test("stop_hook_active lets it through — we have already said our piece", () => {
    const v = decideStop([started("build")], [live("build")], true);
    expect(v.kind).toBe("allow");
  });

  test("several outstanding ops are named in one remedy", () => {
    const v = decideStop(
      [started("build"), started("test")],
      [live("build"), live("test")],
      false,
    );
    expect(v.kind === "block" && v.reason).toContain("await build test");
  });

  test("the reason says a 70 is not a failure, so a capped wait is not read as one", () => {
    const v = decideStop([started("check")], [live("check")], false);
    expect(v.kind === "block" && v.reason).toContain("70");
  });
});

describe("agentMatches", () => {
  test("the usual case: the payload carries the same agent id", () => {
    expect(agentMatches("awake-test-f92bd72", "awake-test-f92bd72")).toBe(true);
  });

  test("a TeammateIdle naming the teammate still finds its ledger entry", () => {
    // Measured: teammate `wake-test` records under `awake-test-f92bd7289978be0b`.
    expect(agentMatches("awake-test-f92bd7289978be0b", "wake-test")).toBe(true);
  });

  test("a different teammate does not", () => {
    expect(agentMatches("awake-test-f92bd72", "other-test")).toBe(false);
  });

  test("a name that is only a prefix of another does not match it", () => {
    expect(agentMatches("awake-test-two-abc123", "wake-test")).toBe(false);
  });
});
