// The boot-equality check: the tuple a paged read subscribes for its first
// page, so a suite holding a real boot-preloaded collection (the
// conversations' `conversationsGone`) pins it equal to the default tuple the
// boot snapshot hydrates.
export { pageZeroParams } from "./page-zero";
// Occupied send lanes — pins the lane registry's reclamation from a writer's
// own suite (optimistic-mutation's hook tests).
export { activeSendLaneCount } from "../internal/send-lane";
// What a writer's suite checks its sink emissions and deadline against: the
// write sinks' payloads, and the default unconfirmed deadline.
export type {
  OptimisticDivergenceReport,
  OptimisticRejectionReport,
} from "../internal/write-sinks";
export { UNCONFIRMED_MS } from "../internal/unconfirmed-deadline";
