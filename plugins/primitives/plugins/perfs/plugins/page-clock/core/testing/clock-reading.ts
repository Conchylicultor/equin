import {
  asEpochMs,
  asPerfMs,
  offsetOf,
  type ClockReading,
} from "../internal/clock";

/**
 * A clock reading for a test that does not stub the clocks: the timeline at
 * `perf` while the wall clock read `epoch`.
 */
export function clockReadingAt(epoch: number, perf: number): ClockReading {
  return {
    perf: asPerfMs(perf),
    offset: offsetOf(asEpochMs(epoch), asPerfMs(perf)),
  };
}
