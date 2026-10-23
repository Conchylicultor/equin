import type { StallFrame } from "../../core";
import { STALL } from "./constants";

// The Long Animation Frames API entry (Chrome 123+), not yet in TS's DOM lib.
interface LoafScript {
  invokerType: string;
  invoker: string;
  sourceURL: string;
  sourceFunctionName: string;
  sourceCharPosition: number;
  duration: number;
  forcedStyleAndLayoutDuration: number;
  pauseDuration: number;
}
export interface LoafEntry extends PerformanceEntry {
  blockingDuration: number;
  renderStart: number;
  styleAndLayoutStart: number;
  scripts: readonly LoafScript[];
}

export const LOAF_ENTRY_TYPE = "long-animation-frame";

export function loafSupported(): boolean {
  return (
    typeof PerformanceObserver !== "undefined" &&
    PerformanceObserver.supportedEntryTypes.includes(LOAF_ENTRY_TYPE)
  );
}

const cap = (s: string): string =>
  s.length > STALL.STRING_CAP ? `${s.slice(0, STALL.STRING_CAP)}…` : s;

/** A LoAF entry on the wall clock, its longest scripts first (capped). */
export function toStallFrame(e: LoafEntry): StallFrame {
  const startedAt = performance.timeOrigin + e.startTime;
  const offset = (t: number): number | null =>
    t > 0 ? Math.round(t - e.startTime) : null;
  return {
    startedAt: Math.round(startedAt),
    durationMs: Math.round(e.duration),
    blockingDurationMs: Math.round(e.blockingDuration),
    renderStartMs: offset(e.renderStart),
    styleAndLayoutStartMs: offset(e.styleAndLayoutStart),
    scripts: [...e.scripts]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, STALL.MAX_SCRIPTS)
      .map((s) => ({
        invokerType: s.invokerType,
        invoker: cap(s.invoker),
        sourceURL: cap(s.sourceURL),
        sourceFunctionName: cap(s.sourceFunctionName),
        sourceCharPosition: s.sourceCharPosition,
        durationMs: Math.round(s.duration),
        forcedStyleAndLayoutDurationMs: Math.round(
          s.forcedStyleAndLayoutDuration,
        ),
        pauseDurationMs: Math.round(s.pauseDuration),
      })),
  };
}
