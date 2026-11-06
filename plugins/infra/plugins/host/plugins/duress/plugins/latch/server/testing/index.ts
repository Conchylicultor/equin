// Test-only seams: point the latch at a temp dir, drive its clock, and wait for
// the watch to pick up a write made behind the API's back.
export {
  _breakLatchWatchForTests,
  _nextLatchReadForTests,
  _setClockForTests,
  _setLatchDirForTests,
} from "../internal/latch";
