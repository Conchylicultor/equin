/**
 * The health report's Database row, driven through its real hook with the
 * live read stubbed: not known yet → unknown (never green), a recent call
 * with no reply on any pool → attention with a count, the latest's pool, caller
 * and clock time, and back to ok once the last hit is 10 minutes old — by ONE
 * scheduled timer, no polling.
 */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceResult } from "@plugins/primitives/plugins/live-state/web";
import { ResourceError } from "@plugins/primitives/plugins/live-state/core";
import type { QueryDeadlineHit, QueryDeadlines } from "../../core";

let resourceValue: ResourceResult<QueryDeadlines>;

vi.mock("@plugins/network/plugins/live/web", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useLive: () => resourceValue,
}));

import { useDatabaseHealth } from "../internal/use-database-health";

const START = new Date(2026, 8, 11, 12, 0, 0).getTime();
const MIN = 60_000;
const refetch = () => Promise.resolve();

function settled(hits: QueryDeadlineHit[]): ResourceResult<QueryDeadlines> {
  return { status: "ready", data: { hits }, refetch };
}

function hit(
  at: number,
  over: Partial<QueryDeadlineHit> = {},
): QueryDeadlineHit {
  return {
    at,
    pool: "app",
    phase: "query",
    sql: "select count(*) from conversations_v",
    origin: "push conversations-gone-stats",
    elapsedMs: 60_000,
    ...over,
  };
}

const OK = "No unanswered database calls in the last 10 min";

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

beforeEach(() => {
  // Fake the timers too (the shared setup fakes only Date), so advancing the
  // clock also fires the row's one expiry timer.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  vi.setSystemTime(START);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("Database health row", () => {
  it("is unknown — not ok — while the resource has not loaded", () => {
    resourceValue = { status: "loading", refetch };
    const { result } = renderHook(() => useDatabaseHealth());
    expect(result.current).toEqual({ state: "unknown" });
  });

  it("is unknown with a reason when the resource failed to load", () => {
    resourceValue = {
      status: "error",
      error: new ResourceError("loader-failed", "boom", null),
      refetch,
    };
    const { result } = renderHook(() => useDatabaseHealth());
    expect(result.current).toEqual({
      state: "unknown",
      summary: "Couldn't load recent database call failures",
    });
  });

  it("is ok with no unanswered calls", () => {
    resourceValue = settled([]);
    const { result } = renderHook(() => useDatabaseHealth());
    expect(result.current).toEqual({
      state: "ok",
      summary: OK,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("turns attention on a recent hit, counts down, and returns to ok after 10 min", () => {
    resourceValue = settled([]);
    const { result, rerender } = renderHook(() => useDatabaseHealth());
    expect(result.current.state).toBe("ok");

    // Two queries lost: one 3 min ago, one 1 min ago (pushed together).
    const first = START - 3 * MIN;
    const last = START - 1 * MIN;
    resourceValue = settled([
      hit(first),
      hit(last, { pool: "jobs-enqueue", origin: "tasks.maybe-launch" }),
    ]);
    rerender();
    expect(result.current).toEqual({
      state: "attention",
      summary: `2 database calls got no reply in the last 10 min — last: jobs-enqueue, issued by tasks.maybe-launch, at ${clock(last)}`,
    });
    // One timer, aimed at the next expiry — not an interval.
    expect(vi.getTimerCount()).toBe(1);

    // 7 min later the first one is 10 min old: the count drops on its own.
    act(() => {
      vi.advanceTimersByTime(7 * MIN);
    });
    expect(result.current).toEqual({
      state: "attention",
      summary: `1 database call got no reply in the last 10 min — jobs-enqueue, issued by tasks.maybe-launch, at ${clock(last)}`,
    });
    expect(vi.getTimerCount()).toBe(1);

    // 2 more minutes: the last one is 10 min old — green again, no timer left.
    act(() => {
      vi.advanceTimersByTime(2 * MIN);
    });
    expect(result.current).toEqual({
      state: "ok",
      summary: OK,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("says a connect was opening a connection, and leaves out an unknown caller", () => {
    resourceValue = settled([
      hit(START - 2 * MIN, {
        pool: "jobs-runner",
        origin: "tasks.maybe-launch",
      }),
      hit(START - 1 * MIN, {
        pool: "admin",
        phase: "connect",
        sql: "[connect]",
        origin: null,
      }),
    ]);
    const { result } = renderHook(() => useDatabaseHealth());
    expect(result.current).toEqual({
      state: "attention",
      summary: `2 database calls got no reply in the last 10 min — last: opening an admin connection, at ${clock(START - 1 * MIN)}`,
    });
  });

  it("stays green for a hit that had already aged out when it was read", () => {
    // A reconnect replays the ring: a hit from 15 min ago is history, not news.
    resourceValue = settled([hit(START - 15 * MIN)]);
    const { result } = renderHook(() => useDatabaseHealth());
    expect(result.current.state).toBe("ok");
  });

  it("re-arms for a new hit after the row went back to ok", () => {
    resourceValue = settled([hit(START)]);
    const { result, rerender } = renderHook(() => useDatabaseHealth());
    expect(result.current.state).toBe("attention");

    act(() => {
      vi.advanceTimersByTime(10 * MIN);
    });
    expect(result.current.state).toBe("ok");

    // An hour on, another query is lost.
    act(() => {
      vi.advanceTimersByTime(60 * MIN);
    });
    const later = START + 70 * MIN;
    resourceValue = settled([hit(START), hit(later)]);
    rerender();
    expect(result.current).toEqual({
      state: "attention",
      summary: `1 database call got no reply in the last 10 min — app, issued by push conversations-gone-stats, at ${clock(later)}`,
    });

    act(() => {
      vi.advanceTimersByTime(10 * MIN);
    });
    expect(result.current.state).toBe("ok");
  });
});
