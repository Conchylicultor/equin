import { describe, expect, test } from "bun:test";
import {
  CLIENT_LATENCY_SIGNALS,
  clientLatencySink,
  splitPhases,
  type ClientLatencySample,
} from "./signals";

describe("splitPhases", () => {
  test("keeps non-negative phases, so consecutive spans still sum to the total", () => {
    const changedAt = 1000;
    const deliverMs = 15;
    const sentAt = 1040;
    const receivedAt = 1052;
    const appliedAt = 1060;
    const phases = splitPhases("update", {
      "server-notice": sentAt - deliverMs - changedAt,
      "server-deliver": deliverMs,
      transport: receivedAt - sentAt,
      "client-apply": appliedAt - receivedAt,
    });
    expect(phases).toEqual({
      "server-notice": 25,
      "server-deliver": 15,
      transport: 12,
      "client-apply": 8,
    });
    const sum = Object.values<number>(phases).reduce((a, b) => a + b, 0);
    expect(sum).toBe(appliedAt - changedAt);
  });

  test("clamps a negative phase to 0", () => {
    const phases = splitPhases("confirm", {
      "send-lane": 3,
      retry: 0,
      "server-ack": 40,
      "confirm-frame": -12,
    });
    expect(phases["confirm-frame"]).toBe(0);
    expect(phases["server-ack"]).toBe(40);
  });

  test("returns exactly the signal's phases, in table order", () => {
    const phases = splitPhases("confirm", {
      "send-lane": 1,
      retry: 2,
      "server-ack": 3,
      "confirm-frame": 4,
    });
    expect(Object.keys(phases)).toEqual([...CLIENT_LATENCY_SIGNALS.confirm]);
  });

  test("tsc rejects a missing or foreign phase", () => {
    // @ts-expect-error — `client-apply` missing
    splitPhases("update", {
      "server-notice": 0,
      "server-deliver": 0,
      transport: 0,
    });
    const sample: ClientLatencySample = {
      signal: "confirm",
      key: "k",
      params: {},
      // @ts-expect-error — an update phase on a confirm sample
      phases: { "send-lane": 0, retry: 0, "server-ack": 0, transport: 0 },
      totalMs: 0,
      hidden: false,
    };
    expect(sample.signal).toBe("confirm");
  });
});

describe("clientLatencySink", () => {
  test("delivers a sample to a subscriber", () => {
    const seen: ClientLatencySample[] = [];
    const off = clientLatencySink.subscribe((s) => seen.push(s));
    const sample: ClientLatencySample = {
      signal: "update",
      key: "tasks",
      params: {},
      phases: {
        "server-notice": 1,
        "server-deliver": 2,
        transport: 3,
        "client-apply": 4,
      },
      totalMs: 10,
      hidden: false,
    };
    clientLatencySink.emit(sample);
    off();
    expect(seen).toEqual([sample]);
    expect(clientLatencySink.hasSubscribers()).toBe(false);
  });
});
