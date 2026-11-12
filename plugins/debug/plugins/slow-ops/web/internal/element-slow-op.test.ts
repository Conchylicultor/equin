import { describe, expect, test } from "bun:test";
import type { SlowResourceInfo } from "@plugins/network/plugins/live/plugins/live-state/web";
import type { HostBootInfo } from "@plugins/framework/plugins/browser-server/web";
import {
  elementSlowOp,
  hostBootSlowOp,
  transportSlowOp,
} from "./element-slow-op";

const thresholds = {
  pageLoadMs: 2000,
  elementMs: 1000,
  updateMs: 1000,
  confirmMs: 2000,
  loaderMs: 2000,
  httpMs: 2000,
  dbMs: 500,
  jobMs: 3000,
  gateQueueDepth: 0.25,
  browserHostBootMs: 5000,
};

const settle = (over: Partial<SlowResourceInfo> = {}): SlowResourceInfo => ({
  key: "edited-files",
  params: { conversationId: "conv-1", page: "b" },
  durationMs: 1609.4,
  transportColdStart: false,
  transportWaitMs: 0,
  serverJoinedMs: 0,
  transportReadyAtMs: null,
  transportStartedAtMs: null,
  transportId: "/ws/notifications",
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

  test("the server's join on another run is charged to its own layer, off its own time", () => {
    const item = elementSlowOp(
      settle({ durationMs: 3500, serverJoinedMs: 2400 }),
      thresholds,
      "/",
    );
    expect(item?.ownMs).toBe(1100);
    expect(item?.waits).toEqual({ "server-join": 2400 });
    // All of it the joined run's (a watcher pass, filed on its own span).
    expect(
      elementSlowOp(
        settle({ durationMs: 3000, serverJoinedMs: 2600 }),
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

// The acceptance case of the browser-host boot split: a read of a demo's
// in-browser server mounts only once the host is ready, so its own transport
// is ready a microtask after it mounts (a few ms of bring-up) — a 3 s delay of
// its own after the boot is still the element's, reported in full.
test("a read of an in-browser server slow after the boot is still reported", () => {
  const item = elementSlowOp(
    settle({
      key: "config-v2.values",
      durationMs: 3007,
      transportColdStart: true,
      transportWaitMs: 7,
      transportStartedAtMs: 25591,
      transportReadyAtMs: 25598,
      transportId: "browser:srv-1:/ws/notifications",
    }),
    thresholds,
    "/demo/at/agents/c/conv-demo-practice-timer",
  );
  expect(item?.ownMs).toBe(3000);
  expect(item?.operation).toBe("config-v2.values");
});

describe("transportSlowOp", () => {
  test("the bring-up is filed against the transport, as a wait", () => {
    expect(transportSlowOp(200, 5000.4, thresholds, "/home")).toEqual({
      operationKind: "wait",
      operation: "notifications-transport",
      durationMs: 4800,
      ownMs: 4800,
      thresholdMs: 1000,
      caller: { kind: "route", label: "/home" },
    });
    expect(transportSlowOp(0, 900, thresholds, "/home")).toBeNull();
  });

  test("measured from the pipeline's own start, never the page's", () => {
    // A demo's scoped pipeline opened its socket 33.5 s into the page (the
    // visitor at the gate, then the host's boot) and was ready 7 ms later:
    // no transport wait at all. Measured from the page's start it was filed
    // as a 33.5 s `wait notifications-transport` (main, 2026-11-12).
    expect(transportSlowOp(33_485, 33_492, thresholds, "/demo")).toBeNull();
  });
});

const boot = (over: Partial<HostBootInfo> = {}): HostBootInfo => ({
  host: "agent-manager",
  waitedMs: 19_285.6,
  askedAtMs: 3021,
  readyAtMs: 19_100,
  boot: {
    plugins: 321,
    stages: [
      { name: "script", ms: 150 },
      { name: "storage", ms: 400 },
      { name: "graph", ms: 15_000 },
      { name: "ready", ms: 200 },
    ],
    slowest: [{ label: "onReadyBlocking:database", ms: 6000 }],
    data: "snapshot",
  },
  ...over,
});

describe("hostBootSlowOp", () => {
  test("a boot past its budget is one op against the host, split by stage", () => {
    expect(hostBootSlowOp(boot(), thresholds, "/demo/at/agents")).toEqual({
      operationKind: "boot",
      operation: "browser-host:agent-manager",
      durationMs: 19_286,
      ownMs: 19_286,
      thresholdMs: 5000,
      caller: { kind: "route", label: "/demo/at/agents" },
      detail: { variant: "snapshot" },
      waits: {
        "host-script": 150,
        "host-storage": 400,
        "host-graph": 15_000,
        "host-ready": 200,
        "host-unstaged": 3536,
      },
    });
  });

  test("within the budget is not slow; the budget is browserHostBootMs", () => {
    expect(
      hostBootSlowOp(boot({ waitedMs: 2000 }), thresholds, "/"),
    ).toBeNull();
    expect(
      hostBootSlowOp(boot(), { ...thresholds, browserHostBootMs: 20_000 }, "/"),
    ).toBeNull();
  });

  test("a host keeping no data names that as its variant", () => {
    const b = boot();
    const { data: _data, ...noData } = b.boot;
    expect(
      hostBootSlowOp({ ...b, boot: noData }, thresholds, "/")?.detail,
    ).toEqual({ variant: "no data kept" });
  });
});
