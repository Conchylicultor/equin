import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clientLatencySink,
  type ClientLatencySample,
} from "@plugins/primitives/plugins/perfs/plugins/latency-signal/core";
import {
  armUnconfirmedDeadline,
  UNCONFIRMED_MS,
  type UnconfirmedSample,
} from "../internal/unconfirmed-deadline";

const sample = (): UnconfirmedSample => ({
  signal: "confirm",
  censored: true,
  key: "k",
  params: {},
  variant: "unconfirmed/awaiting-ack",
  phases: { "send-lane": 0, retry: 0 },
  totalMs: UNCONFIRMED_MS,
  hidden: false,
});

describe("armUnconfirmedDeadline", () => {
  let seen: ClientLatencySample[];
  let off: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    seen = [];
    off = clientLatencySink.subscribe((s) => seen.push(s));
  });
  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  it("emits one censored sample at the deadline, never again", () => {
    const build = vi.fn(sample);
    armUnconfirmedDeadline({ sample: build });
    vi.advanceTimersByTime(UNCONFIRMED_MS - 1);
    expect(seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(seen).toEqual([sample()]);
    vi.advanceTimersByTime(UNCONFIRMED_MS * 5);
    expect(build).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(1);
  });

  it("a cleared deadline emits nothing; clear is idempotent", () => {
    const d = armUnconfirmedDeadline({ sample });
    vi.advanceTimersByTime(UNCONFIRMED_MS / 2);
    d.clear();
    d.clear();
    vi.advanceTimersByTime(UNCONFIRMED_MS * 2);
    expect(seen).toEqual([]);
  });

  it("honours a custom deadline", () => {
    armUnconfirmedDeadline({ deadlineMs: 50, sample });
    vi.advanceTimersByTime(50);
    expect(seen).toHaveLength(1);
  });

  it("builds nothing when the sink has no subscriber", () => {
    off();
    const build = vi.fn(sample);
    armUnconfirmedDeadline({ sample: build });
    vi.advanceTimersByTime(UNCONFIRMED_MS);
    expect(build).not.toHaveBeenCalled();
  });
});
