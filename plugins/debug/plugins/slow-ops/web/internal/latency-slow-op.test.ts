import { describe, expect, test } from "bun:test";
import type { ClientLatencySample } from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import { latencySlowOp } from "./latency-slow-op";

const thresholds = {
  pageLoadMs: 2000,
  elementMs: 1000,
  updateMs: 1000,
  confirmMs: 2000,
  loaderMs: 2000,
  httpMs: 2000,
  dbMs: 500,
  jobMs: 3000,
};

const update = (over: Partial<ClientLatencySample> = {}): ClientLatencySample =>
  ({
    signal: "update",
    key: "tasks",
    params: { status: "open", id: "7" },
    phases: {
      "server-notice": 900,
      "server-deliver": 300,
      transport: 2,
      "client-apply": 4,
    },
    totalMs: 1206.4,
    hidden: false,
    ...over,
  }) as ClientLatencySample;

const confirm = (totalMs: number): ClientLatencySample => ({
  signal: "confirm",
  key: "page.blocks",
  params: { pageId: "p1" },
  variant: "exact-ack/push",
  phases: {
    "send-lane": 0,
    retry: 0,
    "server-ack": totalMs - 100,
    "confirm-frame": 100,
  },
  totalMs,
  hidden: false,
});

describe("latencySlowOp", () => {
  test("builds the item: key as operation, phases as waits, canonical params as variant", () => {
    expect(latencySlowOp(update(), thresholds, "/agents")).toEqual({
      operationKind: "update",
      operation: "tasks",
      durationMs: 1206,
      thresholdMs: 1000,
      caller: { kind: "route", label: "/agents" },
      detail: { variant: '{"id":"7","status":"open"}' },
      waits: {
        "server-notice": 900,
        "server-deliver": 300,
        transport: 2,
        "client-apply": 4,
      },
    });
  });

  test("a sample's own variant wins over its params", () => {
    expect(latencySlowOp(confirm(2500), thresholds, "/")?.detail).toEqual({
      variant: "exact-ack/push",
    });
  });

  test("reads the threshold per signal", () => {
    // 1500 ms trips update (1000) but not confirm (2000).
    expect(
      latencySlowOp(update({ totalMs: 1500 }), thresholds, "/"),
    ).not.toBeNull();
    expect(latencySlowOp(confirm(1500), thresholds, "/")).toBeNull();
    expect(latencySlowOp(confirm(2001), thresholds, "/")?.thresholdMs).toBe(
      2000,
    );
    expect(
      latencySlowOp(
        update({ totalMs: 1500 }),
        { ...thresholds, updateMs: 2000 },
        "/",
      ),
    ).toBeNull();
  });

  test("at the threshold is not slow", () => {
    expect(
      latencySlowOp(update({ totalMs: 1000 }), thresholds, "/"),
    ).toBeNull();
  });

  test("skips a hidden sample however slow", () => {
    expect(
      latencySlowOp(update({ totalMs: 60_000, hidden: true }), thresholds, "/"),
    ).toBeNull();
  });

  test("files a censored (never-confirmed) sample as its own operation, with the phases it reached", () => {
    const censored: ClientLatencySample = {
      signal: "confirm",
      censored: true,
      key: "page.blocks",
      params: { pageId: "p1" },
      variant: "unconfirmed/awaiting-confirm-frame",
      phases: { "send-lane": 0, retry: 0, "server-ack": 80 },
      totalMs: 10_000.4,
      hidden: false,
      detail: { ackWatermark: "123" },
    };
    const item = latencySlowOp(censored, thresholds, "/pages");
    expect(item).toEqual({
      operationKind: "confirm",
      operation: "page.blocks (unconfirmed)",
      durationMs: 10_000,
      thresholdMs: 2000,
      caller: { kind: "route", label: "/pages" },
      detail: {
        variant: "unconfirmed/awaiting-confirm-frame",
        censored: true,
        evidence: { ackWatermark: "123" },
      },
      waits: { "send-lane": 0, retry: 0, "server-ack": 80 },
    });
    // Distinct from the slow-but-confirmed row (and so its report fingerprint).
    expect(item?.operation).not.toBe(
      latencySlowOp(confirm(2500), thresholds, "/")?.operation,
    );
  });

  test("a censored sample under the threshold, or hidden, files nothing", () => {
    const base = {
      signal: "confirm" as const,
      censored: true as const,
      key: "k",
      params: {},
      phases: {},
      hidden: false,
    };
    expect(
      latencySlowOp({ ...base, totalMs: 1500 }, thresholds, "/"),
    ).toBeNull();
    expect(
      latencySlowOp(
        { ...base, totalMs: 60_000, hidden: true },
        thresholds,
        "/",
      ),
    ).toBeNull();
  });
});
