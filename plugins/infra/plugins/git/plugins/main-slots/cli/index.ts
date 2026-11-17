// Shared CLI machinery, not a command (no default export): the build's half of
// the slot pool — pick, make, check out and install a slot for a build, hand
// it over, and reclaim the pool once the build is done. The reclaim command
// is the `reclaim` sub-plugin's.
export {
  acquireBuildSlot,
  DRAINING_SLOT_LIMIT,
  runInBuildSlot,
} from "./internal/acquire-build-slot";
export type {
  AcquireBuildSlotOptions,
  BuildSlot,
  HandedSlot,
  HeldSlot,
  RunInBuildSlotOptions,
} from "./internal/acquire-build-slot";
export { FREE_SLOTS_KEPT, reclaimSlots } from "./internal/reclaim";
export type { ReclaimOptions, ReclaimOutcome } from "./internal/reclaim";
export { readDrainReportAfterMs } from "./internal/config-read";
