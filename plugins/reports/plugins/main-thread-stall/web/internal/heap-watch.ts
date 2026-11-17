import type { StallMemory } from "@plugins/reports/plugins/main-thread-stall/plugins/tab-evidence/core";
import type { MainThreadStallDraft } from "../../core";
import { STALL } from "./constants";

// The tab's JS heap around a stall. A sampled profile that saw no JS through a
// freeze (report-1794677822-avxup9: 49 s, every sample without a stack, the
// sampler itself starved) cannot say whether V8 was collecting garbage near
// its heap ceiling, the process was starved, or the JS ran in scripts the
// profiler may not show. The heap just before and right after says which: a
// heap near its limit that dropped after is a collection.
//
// Read on each watchdog ping (or the fallback's heartbeat) — no timer of its
// own; a frozen thread reads nothing, so the last reading before a freeze is
// the one taken at its last pong. Chrome's `performance.memory` is a cached,
// coarse read (no heap walk).

/** Readings kept: a freeze is filed a few pings after it ends. */
const KEEP = 30;

interface Reading {
  at: number;
  usedMb: number;
}

export interface HeapWatch {
  /** The clock moved (a watchdog ping, a heartbeat): read the heap. */
  pulse(): void;
  /** The heap around a stall this tab is filing (its own, recovered — else why not). */
  memoryFor(draft: MainThreadStallDraft, ownTabId: string): StallMemory;
  /**
   * The heap around a long frame this tab ran and lived through (`startedAt`,
   * epoch ms — exact, from its LoAF entry): the last reading before it, and now.
   */
  memoryAround(window: { startedAt: number }): StallMemory;
}

interface MemoryInfo {
  usedJSHeapSize: number;
  jsHeapSizeLimit: number;
}

function memoryInfo(): MemoryInfo | null {
  const m = (performance as unknown as { memory?: MemoryInfo }).memory;
  return m && typeof m.usedJSHeapSize === "number" ? m : null;
}

const mb = (bytes: number): number => Math.round(bytes / 1_000_000);

export function installHeapWatch(): HeapWatch {
  const readings: Reading[] = [];
  /** The heap now, and the last reading taken by `beforeBy` (epoch ms). */
  const measure = (beforeBy: number, startedAt: number): StallMemory => {
    const m = memoryInfo();
    if (!m)
      return {
        kind: "unavailable",
        reason:
          "this browser exposes no JS heap size (`performance.memory`: Chromium only)",
      };
    const before = readings.findLast((r) => r.at <= beforeBy);
    return {
      kind: "measured",
      beforeMb: before?.usedMb ?? null,
      beforeAgoMs:
        before === undefined
          ? null
          : Math.max(0, Math.round(startedAt - before.at)),
      afterMb: mb(m.usedJSHeapSize),
      limitMb: mb(m.jsHeapSizeLimit),
    };
  };
  return {
    pulse() {
      const m = memoryInfo();
      if (!m) return;
      readings.push({ at: Date.now(), usedMb: mb(m.usedJSHeapSize) });
      if (readings.length > KEEP) readings.shift();
    },
    memoryFor(draft, ownTabId) {
      if (draft.ended !== "recovered")
        return {
          kind: "unavailable",
          reason: `the tab did not survive the stall (${draft.ended}): its heap went with it`,
        };
      if (draft.tabId !== ownTabId)
        return {
          kind: "unavailable",
          reason:
            "filed by another tab: only the stalled tab can read its own heap",
        };
      // The stall began at the last pong, read just before it; no reading
      // happens inside a freeze (≥ REPORT_MIN_MS), so one within a ping of its
      // start is from before it.
      return measure(draft.startedAt + STALL.PING_MS, draft.startedAt);
    },
    memoryAround(window) {
      // A frame's start is its own (LoAF), not a pong's: a reading at or
      // before it is from before it.
      return measure(window.startedAt, window.startedAt);
    },
  };
}
