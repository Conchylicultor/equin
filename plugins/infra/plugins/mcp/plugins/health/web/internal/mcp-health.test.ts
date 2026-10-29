import { describe, expect, test } from "bun:test";
import type { McpHealth } from "@plugins/infra/plugins/mcp/core";
import { mcpVerdict } from "./mcp-health";

const refetch = async () => {};
const ready = (data: Partial<McpHealth>) =>
  mcpVerdict({
    status: "ready",
    data: {
      requests: { kind: "ok" },
      degraded: [],
      degradedMore: 0,
      ...data,
    },
    refetch,
  });

describe("mcpVerdict", () => {
  test("loading is unknown, never ok", () => {
    expect(mcpVerdict({ status: "loading", refetch })).toEqual({
      state: "unknown",
    });
  });

  test("answering, or never asked, is ok", () => {
    expect(ready({}).state).toBe("ok");
    expect(ready({ requests: { kind: "none" } })).toEqual({
      state: "ok",
      summary: "No agent has connected yet",
    });
  });

  test("a failing latest request is critical, with why", () => {
    expect(
      ready({ requests: { kind: "failing", message: "boom", at: 1 } }),
    ).toEqual({ state: "critical", summary: "Failing: boom" });
  });

  test("a failing contribution is attention, named when alone", () => {
    const one = { what: 'tool "x" when', message: "m", at: 1 };
    expect(ready({ degraded: [one] })).toEqual({
      state: "attention",
      summary: 'Degraded: tool "x" when fails',
    });
    expect(ready({ degraded: [one], degradedMore: 2 }).summary).toBe(
      "Degraded: 3 contributions fail",
    );
  });

  test("failing outranks degraded", () => {
    expect(
      ready({
        requests: { kind: "failing", message: "boom", at: 1 },
        degraded: [{ what: "w", message: "m", at: 1 }],
      }).state,
    ).toBe("critical");
  });
});
