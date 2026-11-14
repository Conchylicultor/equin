import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import type { MainThreadStallDraft } from "../../core";
import { installHeapWatch } from "./heap-watch";

const T0 = 1_700_000_000_000;
const perf = performance as unknown as {
  memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number };
};
let saved: typeof perf.memory;

beforeEach(() => {
  saved = perf.memory;
  perf.memory = { usedJSHeapSize: 0, jsHeapSizeLimit: 4_000_000_000 };
});
afterEach(() => {
  perf.memory = saved;
  setSystemTime();
});

function heapAt(at: number, usedMb: number): void {
  setSystemTime(new Date(at));
  perf.memory!.usedJSHeapSize = usedMb * 1_000_000;
}

const draft = (
  over: Partial<MainThreadStallDraft> = {},
): MainThreadStallDraft =>
  ({
    tabId: "tab-1",
    startedAt: T0 + 3_000,
    endedAt: T0 + 52_000,
    ended: "recovered",
    ...over,
  }) as MainThreadStallDraft;

describe("installHeapWatch", () => {
  test("the heap at the last pulse before the stall, and now", () => {
    const w = installHeapWatch();
    heapAt(T0 + 1_000, 3_500);
    w.pulse();
    // The pulse that answered the stall's last pong, a few ms before the
    // watchdog stamped it.
    heapAt(T0 + 2_995, 3_900);
    w.pulse();
    // Back: pings resume before the tab files.
    heapAt(T0 + 52_100, 1_200);
    w.pulse();
    heapAt(T0 + 54_000, 1_210);
    expect(w.memoryFor(draft(), "tab-1")).toEqual({
      kind: "measured",
      beforeMb: 3_900,
      beforeAgoMs: 5,
      afterMb: 1_210,
      limitMb: 4_000,
    });
  });

  test("no reading before the stall is null, never a stand-in", () => {
    const w = installHeapWatch();
    heapAt(T0 + 52_100, 800);
    w.pulse();
    expect(w.memoryFor(draft(), "tab-1")).toMatchObject({
      kind: "measured",
      beforeMb: null,
      beforeAgoMs: null,
      afterMb: 800,
    });
  });

  test("only the stalled tab, recovered, has its heap", () => {
    const w = installHeapWatch();
    expect(w.memoryFor(draft(), "tab-2").kind).toBe("unavailable");
    expect(w.memoryFor(draft({ ended: "gone" }), "tab-1").kind).toBe(
      "unavailable",
    );
  });

  test("a browser without performance.memory says so", () => {
    perf.memory = undefined;
    const w = installHeapWatch();
    w.pulse();
    const m = w.memoryFor(draft(), "tab-1");
    expect(m.kind === "unavailable" && m.reason).toContain(
      "performance.memory",
    );
  });
});
