import { describe, expect, test } from "bun:test";
import type { SlowResourceInfo } from "@plugins/primitives/plugins/live-state/web";
import { elementSlowOp, transportSlowOp } from "./element-slow-op";

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

const settle = (over: Partial<SlowResourceInfo> = {}): SlowResourceInfo => ({
  key: "edited-files",
  params: { conversationId: "conv-1", page: "b" },
  durationMs: 1609.4,
  transportColdStart: false,
  transportWaitMs: 0,
  transportReadyAtMs: null,
  ...over,
});

describe("elementSlowOp", () => {
  test("builds the item: key as operation, canonical params as variant", () => {
    expect(elementSlowOp(settle(), thresholds, "/agents/c/1")).toEqual({
      operationKind: "element",
      operation: "edited-files",
      durationMs: 1609,
      ownMs: 1609,
      thresholdMs: 1000,
      caller: { kind: "route", label: "/agents/c/1" },
      detail: { variant: '{"conversationId":"conv-1","page":"b"}' },
      transportColdStart: false,
    });
  });

  test("two tuples of one resource share the operation, differ in variant", () => {
    const a = elementSlowOp(settle(), thresholds, "/");
    const b = elementSlowOp(
      settle({ params: { page: "a", conversationId: "conv-2" } }),
      thresholds,
      "/",
    );
    expect(a?.operation).toBe(b?.operation);
    expect(a?.detail?.variant).not.toBe(b?.detail?.variant);
  });

  test("the variant is key-order independent", () => {
    const item = elementSlowOp(
      settle({ params: { page: "b", conversationId: "conv-1" } }),
      thresholds,
      "/",
    );
    expect(item?.detail?.variant).toBe(
      '{"conversationId":"conv-1","page":"b"}',
    );
  });

  test("charges a transport bring-up wait to its own layer, off its own time", () => {
    const item = elementSlowOp(
      settle({
        durationMs: 3500,
        transportColdStart: true,
        transportWaitMs: 1200,
      }),
      thresholds,
      "/",
    );
    expect(item?.transportColdStart).toBe(true);
    expect(item?.ownMs).toBe(2300);
    expect(item?.waits).toEqual({ "notifications-transport": 1200 });
  });

  test("a settle that was all transport bring-up is not the resource's slowness", () => {
    expect(
      elementSlowOp(
        settle({
          durationMs: 5000,
          transportColdStart: true,
          transportWaitMs: 4800,
        }),
        thresholds,
        "/",
      ),
    ).toBeNull();
  });

  test("at the threshold is not slow; the threshold is elementMs", () => {
    expect(
      elementSlowOp(settle({ durationMs: 1000 }), thresholds, "/"),
    ).toBeNull();
    expect(
      elementSlowOp(settle(), { ...thresholds, elementMs: 2000 }, "/"),
    ).toBeNull();
  });
});

describe("transportSlowOp", () => {
  test("the bring-up is filed against the transport, as a wait", () => {
    expect(transportSlowOp(4800.4, thresholds, "/home")).toEqual({
      operationKind: "wait",
      operation: "notifications-transport",
      durationMs: 4800,
      ownMs: 4800,
      thresholdMs: 1000,
      caller: { kind: "route", label: "/home" },
    });
    expect(transportSlowOp(900, thresholds, "/home")).toBeNull();
  });
});
