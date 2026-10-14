import { describe, expect, test } from "bun:test";
import type { SlowOpClientItem } from "../../shared/endpoints";
import { toRecordInput, toRecordInputs } from "./client-record-input";

const item = (over: Partial<SlowOpClientItem> = {}): SlowOpClientItem => ({
  operationKind: "update",
  operation: "tasks",
  durationMs: 1200,
  thresholdMs: 1000,
  ...over,
});

describe("toRecordInput", () => {
  test("passes the measurement, caller, waits and variant through", () => {
    const waits = { "server-notice": 900, transport: 300 };
    expect(
      toRecordInput(
        item({
          caller: { kind: "route", label: "/agents" },
          waits,
          detail: { variant: '{"id":"7"}' },
          transportColdStart: true,
        }),
        "trace-1",
      ),
    ).toEqual({
      operationKind: "update",
      operation: "tasks",
      durationMs: 1200,
      thresholdMs: 1000,
      source: "client-slow-op",
      caller: { kind: "route", label: "/agents" },
      waits,
      detail: { variant: '{"id":"7"}' },
      transportColdStart: true,
      traceId: "trace-1",
    });
  });

  test("no caller is null; clientBoot never reaches the recorder", () => {
    const input = toRecordInput(
      item({
        operationKind: "page-load",
        clientBoot: {} as SlowOpClientItem["clientBoot"],
      }),
      undefined,
    );
    expect(input.caller).toBeNull();
    expect(input.traceId).toBeUndefined();
    expect("clientBoot" in input).toBe(false);
  });
});

describe("toRecordInputs", () => {
  test("captures one trace per kind — the slowest item — and links every item of that kind", () => {
    const calls: Array<{ op: string; count: number }> = [];
    const inputs = toRecordInputs(
      [
        item({ operation: "a", durationMs: 1100 }),
        item({ operationKind: "confirm", operation: "c", durationMs: 2500 }),
        item({ operation: "b", durationMs: 4000 }),
        item({ operation: "d", durationMs: 1500 }),
      ],
      (rep, count) => {
        calls.push({ op: rep.operation, count });
        return `trace-${rep.operation}`;
      },
    );
    expect(calls).toEqual([
      { op: "b", count: 3 },
      { op: "c", count: 1 },
    ]);
    expect(inputs.map((i) => [i.operation, i.traceId])).toEqual([
      ["a", "trace-b"],
      ["c", "trace-c"],
      ["b", "trace-b"],
      ["d", "trace-b"],
    ]);
  });

  test("a kind whose trace was not admitted links nothing", () => {
    const inputs = toRecordInputs([item(), item()], () => undefined);
    expect(inputs.map((i) => i.traceId)).toEqual([undefined, undefined]);
  });
});
