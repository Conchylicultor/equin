import { describe, expect, test } from "bun:test";
import type { WorktreeOpInfo } from "@plugins/infra/plugins/worktree/server";
import { opsReading } from "./reading";

const op = (
  op: WorktreeOpInfo["op"],
  opportunistic = false,
): WorktreeOpInfo => ({
  slug: "main",
  op,
  pid: 1,
  opId: `${op}-${opportunistic}`,
  startedAt: "2026-11-11T10:00:00Z",
  opportunistic,
});

describe("opsReading", () => {
  test("nothing running is quiet", () => {
    expect(opsReading([])).toEqual({
      busy: false,
      label: "no op running",
      recheckAt: null,
    });
  });

  test("any op someone waits on is busy, named by kind", () => {
    const r = opsReading([op("build"), op("test"), op("build")]);
    expect(r.busy).toBe(true);
    expect(r.label).toBe("3 ops running (build, test)");
  });

  test("an opportunistic op (the idle batch) never ends the idle period it runs in", () => {
    expect(opsReading([op("test", true)]).busy).toBe(false);
    const mixed = opsReading([op("test", true), op("check")]);
    expect(mixed.busy).toBe(true);
    expect(mixed.label).toBe("1 op running (check)");
  });
});
