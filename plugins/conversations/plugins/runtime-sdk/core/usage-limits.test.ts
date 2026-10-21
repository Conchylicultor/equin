import { describe, expect, test } from "bun:test";
import type { ClaudeUsage } from "./claude-usage";
import {
  launchAccount,
  limitReached,
  roomiestAccount,
  viewUsageWindow,
  weekRoom,
} from "./usage-limits";

const NOW = 1_800_000_000_000;
const LATER = NOW + 3_600_000;

const usage = (session: number | null, week: number | null): ClaudeUsage => ({
  observedAt: NOW - 1,
  session: session === null ? null : { utilization: session, resetsAt: LATER },
  week: week === null ? null : { utilization: week, resetsAt: LATER },
});

describe("viewUsageWindow", () => {
  test("current, with its level", () => {
    expect(
      viewUsageWindow({ utilization: 0.5, resetsAt: NOW + 1 }, NOW),
    ).toEqual({
      kind: "current",
      utilization: 0.5,
      level: "ok",
      resetsAt: NOW + 1,
    });
    expect(
      viewUsageWindow({ utilization: 0.8, resetsAt: NOW + 1 }, NOW),
    ).toMatchObject({ level: "high" });
    expect(
      viewUsageWindow({ utilization: 1, resetsAt: NOW + 1 }, NOW),
    ).toMatchObject({ level: "full" });
  });

  test("reset since the reading: not known", () => {
    expect(viewUsageWindow({ utilization: 1, resetsAt: NOW }, NOW)).toEqual({
      kind: "reset",
      resetAt: NOW,
    });
  });
});

describe("limitReached", () => {
  test("no report, or under every limit: none", () => {
    expect(limitReached(undefined, NOW)).toBeNull();
    expect(limitReached(usage(0.9, 0.5), NOW)).toBeNull();
  });
  test("a full window", () => {
    expect(limitReached(usage(1, 0.5), NOW)).toEqual({
      id: "session",
      resetsAt: LATER,
    });
  });
});

describe("weekRoom", () => {
  test("from the week alone", () => {
    expect(weekRoom(usage(1, 0.25), NOW)).toEqual({
      kind: "known",
      left: 0.75,
    });
    expect(weekRoom(usage(0.2, null), NOW)).toEqual({ kind: "unknown" });
    expect(weekRoom(undefined, NOW)).toEqual({ kind: "unknown" });
  });
  test("a week that reset since starts empty", () => {
    const u = usage(null, 0.9);
    expect(weekRoom(u, LATER)).toEqual({ kind: "known", left: 1 });
  });
});

describe("roomiestAccount", () => {
  test("most weekly room, skipping limited accounts, unknown last", () => {
    const byAccount = {
      a: usage(0.1, 0.7),
      b: usage(0.9, 0.2),
      c: usage(1, 0.0),
    };
    expect(roomiestAccount(["a", "b", "c", "d"], byAccount, NOW)).toBe("b");
    expect(roomiestAccount(["c", "d"], byAccount, NOW)).toBe("d");
    expect(roomiestAccount(["c"], byAccount, NOW)).toBeNull();
  });
});

describe("launchAccount", () => {
  const byAccount = { system: usage(1, 0.5), work: usage(0.1, 0.3) };
  const ids = ["system", "work"];
  test("the active account, unless auto-switch moves off a reached limit", () => {
    expect(
      launchAccount({
        ids,
        active: "system",
        autoSwitch: false,
        byAccount,
        now: NOW,
      }),
    ).toBe("system");
    expect(
      launchAccount({
        ids,
        active: "system",
        autoSwitch: true,
        byAccount,
        now: NOW,
      }),
    ).toBe("work");
    expect(
      launchAccount({
        ids,
        active: "work",
        autoSwitch: true,
        byAccount,
        now: NOW,
      }),
    ).toBe("work");
  });
  test("nowhere to go: stays", () => {
    expect(
      launchAccount({
        ids,
        active: "system",
        autoSwitch: true,
        byAccount: { ...byAccount, work: usage(0.2, 1) },
        now: NOW,
      }),
    ).toBe("system");
  });
});
