// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: it takes flock(2)
// locks over `bun:ffi` and reads the data root. `core/` rather than `server/`
// because its holders sit below every server barrel (the backend's and an
// exec child's boot, the guard hook). Never import it from `web/`.
export {
  clearUnserved,
  clearUnservedAt,
  currentLinkFor,
  currentLinksDir,
  isInSlotPool,
  listSlots,
  mainSlotsDir,
  servedMainRoot,
  servedSlotOf,
  serveSlot,
  slotStates,
  stampUnservedSlots,
} from "./internal/slots";
export type { MainSlot, SlotState, SlotStateKind } from "./internal/slots";
export {
  acquireSharedLease,
  claimHandedBuildSlot,
  holdSlotForLife,
  readSlotHolders,
  reapDeadHolders,
  tryExclusiveLease,
  waitExclusiveLease,
} from "./internal/lease";
export type {
  HandedBuildSlot,
  SlotHold,
  SlotLease,
  SlotLockProbe,
  TryExclusiveLease,
} from "./internal/lease";
export { withSlotPool } from "./internal/pool-lock";
export {
  clearSlotHanded,
  markSlotHanded,
  readSlotHanded,
} from "./internal/handoff";
export type { SlotHanded, SlotHandoffHold } from "./internal/handoff";
export { withServedMainRoot } from "./internal/served-hold";
export {
  DRAIN_SLOW_REPORT_KIND,
  DrainSlowPayloadSchema,
  drainSlowFingerprint,
  drainSlowMessage,
  SLOTS_EXHAUSTED_REPORT_KIND,
  SlotsExhaustedPayloadSchema,
} from "./internal/reports";
export type {
  DrainSlowPayload,
  SlotsExhaustedPayload,
} from "./internal/reports";
