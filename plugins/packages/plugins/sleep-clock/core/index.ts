// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: the binding is
// `bun:ffi` (same as packages/flock). Never import it from `web/`.
export {
  createSleepMeter,
  readAwakeClock,
  readSleepClock,
} from "./internal/sleep-clock";
export type {
  AwakeClockReading,
  SleepClockReading,
  SleepMeter,
  SleepReading,
} from "./internal/sleep-clock";
