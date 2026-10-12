export { parseJunit } from "./internal/junit";
export type { JunitSummary } from "./internal/junit";
export {
  readLatestTestStatus,
  readTestStatus,
  testFailureLines,
  writeTestStatus,
} from "./internal/test-status";
export type {
  TestRunnerName,
  TestRunnerOutcome,
  TestStatus,
} from "./internal/test-status";
