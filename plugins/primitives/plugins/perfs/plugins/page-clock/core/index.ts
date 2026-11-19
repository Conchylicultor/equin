export type {
  ClockOffset,
  ClockReading,
  EpochMs,
  PerfMs,
} from "./internal/clock";
export {
  asEpochMs,
  asPerfMs,
  clockOffset,
  epochNow,
  epochToPerf,
  perfNow,
  perfToEpoch,
  perfToEpochAlong,
  readClocks,
} from "./internal/clock";
