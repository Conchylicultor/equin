import { describe, expect, test } from "bun:test";
import type { RecordSlowOpInput } from "./input";
import { BURST_NAMED_CAP, BURST_OPERATION, reportsFor } from "./report-groups";

const item = (
  operation: string,
  ownMs: number,
  over: Partial<RecordSlowOpInput> = {},
): RecordSlowOpInput => ({
  operationKind: "update",
  operation,
  durationMs: ownMs + 100,
  ownMs,
  thresholdMs: 1000,
  source: "client-slow-op",
  ...over,
});

describe("reportsFor", () => {
  test("a lone item files its own report, fingerprinted on its operation", () => {
    const [report, ...rest] = reportsFor([
      item("tasks", 1500, { traceId: "t1", waits: { transport: 1200 } }),
    ]);
    expect(rest).toEqual([]);
    expect(report!.data).toEqual({
      operationKind: "update",
      operation: "tasks",
      durationMs: 1600,
      ownMs: 1500,
      thresholdMs: 1000,
      waits: { transport: 1200 },
      traceId: "t1",
    });
    expect(report!.message).toBe(
      "update tasks took 1500ms of its own (1600ms wall) (threshold 1000ms)",
    );
  });

  test("several items of one kind in a batch are ONE burst report, carrying the slowest", () => {
    const reports = reportsFor([
      item("claude-accounts", 1475),
      item("edited-files", 1955, { traceId: "shared" }),
      item("sentinel.status", 1060),
    ]);
    expect(reports).toHaveLength(1);
    const d = reports[0]!.data;
    expect(d.operation).toBe(BURST_OPERATION);
    expect(d.ownMs).toBe(1955);
    expect(d.traceId).toBe("shared");
    expect(d.burst).toEqual({
      count: 3,
      operations: [
        { operation: "edited-files", ownMs: 1955 },
        { operation: "claude-accounts", ownMs: 1475 },
        { operation: "sentinel.status", ownMs: 1060 },
      ],
    });
  });

  test("one op tripping twice in a batch keeps its own report (its slowest trip)", () => {
    const reports = reportsFor([
      item("tasks", 1100, { detail: { variant: "a" } }),
      item("tasks", 1700, { detail: { variant: "b" } }),
    ]);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.data.operation).toBe("tasks");
    expect(reports[0]!.data.ownMs).toBe(1700);
    expect(reports[0]!.data.burst).toBeUndefined();
  });

  test("kinds are grouped apart: a lone element beside an update burst files its own", () => {
    const reports = reportsFor([
      item("a", 1100),
      item("b", 1200),
      item("prototypes.list", 1300, { operationKind: "element" }),
    ]);
    expect(
      reports.map((r) => `${r.data.operationKind}:${r.data.operation}`),
    ).toEqual([`update:${BURST_OPERATION}`, "element:prototypes.list"]);
  });

  test("a burst names its slowest few and counts the rest", () => {
    const many = Array.from({ length: BURST_NAMED_CAP + 3 }, (_, i) =>
      item(`r${i}`, 1001 + i),
    );
    const [report] = reportsFor(many);
    expect(report!.data.burst!.count).toBe(BURST_NAMED_CAP + 3);
    expect(report!.data.burst!.operations).toHaveLength(BURST_NAMED_CAP);
    expect(report!.message).toEndWith(", +3 more");
  });
});
