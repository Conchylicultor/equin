import { useEffect, useState } from "react";
import {
  clockParamAt,
  pinNow,
  type ClockParam,
} from "@plugins/network/plugins/live/core";

// The reader's half of a clock read (network/live core, `clock.ts`): what a
// read is computed against, pinned and re-pinned by ONE timer to the instant
// the pin changes — a quantum boundary, the next local midnight, the turn of
// a billing month. Not the polling the repo bans: the instant is known in
// advance (a property of the calendar), nothing is asked on wake, and the read
// it feeds is a new tuple pushed by the server like any other.

/**
 * `now` floored to `quantumMs`, re-pinned at each quantum boundary — what a
 * query naming a clock field carries (`useLive` fills it), and what a list
 * computes a clock field's value against between pins. `null` quantum: no
 * clock read, `null`, no timer.
 */
export function useClockPin(quantumMs: number | null): number | null {
  // The clock READ is held in state (taken at mount, and by the timer at each
  // boundary), and the pin derived from it — so render stays pure, and a
  // quantum appearing (a list sorted by a clock field) pins at once.
  const [at, setAt] = useState(() => Date.now());
  useEffect(() => {
    if (quantumMs === null) return;
    // One timer to the next boundary; a hair late, so it never lands on the
    // quantum it is leaving. A read taken long ago (before a quantum
    // appeared) has its boundary in the past: the timer fires at once.
    const next = pinNow(at, quantumMs) + quantumMs;
    const timer = setTimeout(
      () => setAt(Date.now()),
      Math.max(0, next - Date.now() + 50),
    );
    return () => clearTimeout(timer);
  }, [quantumMs, at]);
  return quantumMs === null ? null : pinNow(at, quantumMs);
}

/**
 * A clock param's value now (`clockParam.day()` → today in this browser's
 * zone; `clockParam.month({ zone })` → this month there), re-pinned at the
 * instant it changes — pass it as the value's param:
 * `useLive(appUsageSummary, { today: useClockParam(APP_USAGE_TODAY) })`.
 */
export function useClockParam(param: ClockParam): string {
  const [at, setAt] = useState(() => clockParamAt(param.clock, new Date()));
  useEffect(() => {
    const timer = setTimeout(
      () => setAt(clockParamAt(param.clock, new Date())),
      Math.max(0, at.changesAt.getTime() - Date.now() + 50),
    );
    return () => clearTimeout(timer);
  }, [param, at]);
  return at.value;
}
