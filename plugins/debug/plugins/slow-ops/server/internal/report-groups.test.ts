import { describe, expect, test } from "bun:test";
import type { RecordSlowOpInput } from "./input";
import { BURST_NAMED_CAP, incidentsFor } from "./report-groups";

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

describe("incidentsFor", () => {
  test("a lone item is an incident of one report, fingerprinted on its operation", () => {
    const [incident, ...rest] = incidentsFor([
      item("tasks", 1500, { traceId: "t1", waits: { transport: 1200 } }),
    ]);
    expect(rest).toEqual([]);
    expect(incident).toHaveLength(1);
    expect(incident![0]!.data).toEqual({
      operationKind: "update",
      operation: "tasks",
      durationMs: 1600,
      ownMs: 1500,
      thresholdMs: 1000,
      waits: { transport: 1200 },
      traceId: "t1",
    });
    expect(incident![0]!.message).toBe(
      "update tasks took 1500ms of its own (1600ms wall) (threshold 1000ms)",
    );
  });

  test("several ops of one kind are ONE incident: each its own report, slowest first, each naming the batch", () => {
    const incidents = incidentsFor([
      item("claude-accounts", 1475),
      item("edited-files", 1955, { traceId: "shared" }),
      item("sentinel.status", 1060),
    ]);
    expect(incidents).toHaveLength(1);
    const reports = incidents[0]!;
    expect(reports.map((r) => r.data.operation)).toEqual([
      "edited-files",
      "claude-accounts",
      "sentinel.status",
    ]);
    expect(reports.map((r) => r.data.ownMs)).toEqual([1955, 1475, 1060]);
    const burst = {
      count: 3,
      operations: [
        { operation: "edited-files", ownMs: 1955 },
        { operation: "claude-accounts", ownMs: 1475 },
        { operation: "sentinel.status", ownMs: 1060 },
      ],
    };
    for (const r of reports) expect(r.data.burst).toEqual(burst);
    expect(reports[2]!.message).toEndWith(" — 1 of 3 at once");
  });

  test("one op tripping twice in a batch is one report (its slowest trip), not a burst", () => {
    const incidents = incidentsFor([
      item("tasks", 1100, { detail: { variant: "a" } }),
      item("tasks", 1700, { detail: { variant: "b" } }),
    ]);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toHaveLength(1);
    expect(incidents[0]![0]!.data.ownMs).toBe(1700);
    expect(incidents[0]![0]!.data.burst).toBeUndefined();
  });

  test("kinds are separate incidents: a lone element beside an update burst", () => {
    const incidents = incidentsFor([
      item("a", 1100),
      item("b", 1200),
      item("prototypes.list", 1300, { operationKind: "element" }),
    ]);
    expect(
      incidents.map((i) =>
        i.map((r) => `${r.data.operationKind}:${r.data.operation}`),
      ),
    ).toEqual([["update:b", "update:a"], ["element:prototypes.list"]]);
    expect(incidents[1]![0]!.data.burst).toBeUndefined();
  });

  test("every op of a large burst files its own report; the payload names the slowest few", () => {
    const many = Array.from({ length: BURST_NAMED_CAP + 3 }, (_, i) =>
      item(`r${i}`, 1001 + i),
    );
    const [incident] = incidentsFor(many);
    expect(incident).toHaveLength(BURST_NAMED_CAP + 3);
    const burst = incident![BURST_NAMED_CAP + 2]!.data.burst!;
    expect(burst.count).toBe(BURST_NAMED_CAP + 3);
    expect(burst.operations).toHaveLength(BURST_NAMED_CAP);
  });
});
