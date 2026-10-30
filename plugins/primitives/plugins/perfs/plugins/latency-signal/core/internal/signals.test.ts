import { describe, expect, test } from "bun:test";
import {
  CLIENT_LATENCY_SIGNALS,
  ownMsOf,
  clientLatencySink,
  splitPhases,
  splitReachedPhases,
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
      "throttle-hold": 0,
      "server-deliver": deliverMs,
      transport: receivedAt - sentAt,
      "client-apply": appliedAt - receivedAt,
    });
    expect(phases).toEqual({
      "server-notice": 25,
      "throttle-hold": 0,
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
      "throttle-hold": 0,
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
    };
    expect(sample.signal).toBe("confirm");
  });
});

describe("censored samples", () => {
  test("splitReachedPhases keeps only the reached phases, clamped, in table order", () => {
    const phases = splitReachedPhases("confirm", {
      retry: -1,
      "send-lane": 4,
      "server-ack": undefined,
    });
    expect(phases).toEqual({ "send-lane": 4, retry: 0 });
    expect(Object.keys(phases)).toEqual(["send-lane", "retry"]);
  });

  test("tsc: a censored sample may omit phases; a complete one may not; only confirm censors", () => {
    const base = { key: "k", params: {}, totalMs: 1 };
    const reached = { "send-lane": 0 };
    const censoredConfirm = {
      ...base,
      signal: "confirm" as const,
      censored: true as const,
      phases: reached,
    };
    const uncensoredConfirm = {
      ...base,
      signal: "confirm" as const,
      phases: reached,
    };
    const censoredUpdate = {
      ...base,
      signal: "update" as const,
      censored: true as const,
      phases: { "server-notice": 0 },
    };
    const censored: ClientLatencySample = censoredConfirm;
    // @ts-expect-error — an uncensored sample must carry every phase
    const complete: ClientLatencySample = uncensoredConfirm;
    // @ts-expect-error — `update` is not a censorable signal
    const update: ClientLatencySample = censoredUpdate;
    expect([censored, complete, update].length).toBe(3);
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
        "throttle-hold": 0,
        "server-deliver": 2,
        transport: 3,
        "client-apply": 4,
      },
      totalMs: 10,
    };
    clientLatencySink.emit(sample);
    off();
    expect(seen).toEqual([sample]);
    expect(clientLatencySink.hasSubscribers()).toBe(false);
  });
});

describe("ownMsOf", () => {
  test("subtracts the excluded phases (an update's throttle hold), never below 0", () => {
    const sample: ClientLatencySample = {
      signal: "update",
      key: "queue-health.pulse",
      params: {},
      phases: splitPhases("update", {
        "server-notice": 1,
        "throttle-hold": 998,
        "server-deliver": 1,
        transport: 1,
        "client-apply": 1,
      }),
      totalMs: 1002,
    };
    expect(ownMsOf(sample)).toBe(3);
    expect(ownMsOf({ ...sample, totalMs: 500 })).toBe(0);
  });

  test("an update's notify → send is the server's to judge, not the client's", () => {
    // queue-health.pulse at 14:24:20 on main: 3424 ms, 3295 ms of it waiting
    // in the server's flush behind a slow loader the server already filed.
    const sample: ClientLatencySample = {
      signal: "update",
      key: "queue-health.pulse",
      params: {},
      phases: splitPhases("update", {
        "server-notice": 20,
        "throttle-hold": 0,
        "server-deliver": 3295,
        transport: 100,
        "client-apply": 9,
      }),
      totalMs: 3424,
    };
    expect(ownMsOf(sample)).toBe(129);
  });

  test("a signal with no excluded phase is all own time", () => {
    const sample: ClientLatencySample = {
      signal: "confirm",
      key: "k",
      params: {},
      phases: splitPhases("confirm", {
        "send-lane": 1,
        retry: 0,
        "server-ack": 40,
        "confirm-frame": 0,
      }),
      totalMs: 41,
    };
    expect(ownMsOf(sample)).toBe(41);
  });
});
