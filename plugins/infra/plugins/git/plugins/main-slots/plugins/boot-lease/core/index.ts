// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: it opens the slot's
// lock file. Light on purpose — its closure is node builtins plus a few leaf
// barrels — because its callers take the lease BEFORE they load the code it
// protects. Never import it from `web/`.
export {
  checkoutRootOfSync,
  holdSlotLeaseSync,
  releaseRecordSync,
} from "./internal/hold-sync";
export type { SlotLeaseHold } from "./internal/hold-sync";
export {
  detachedHeadOf,
  drainRecordFor,
  MAIN_SLOT_SERVED_FILE,
  parseDrainRecord,
  parseUnserved,
  renderDrainRecord,
  renderUnserved,
  SLOT_DRAIN_LOG_DIR,
  SLOT_HANDED_FILE,
  SLOT_UNSERVED_FILE,
  slotHandedLockFile,
  MAIN_SLOT_STAMP,
  parseHolder,
  renderHolder,
  SLOT_HOLDER_KINDS,
  slotHolderRole,
  SLOT_LEASES_DIR,
  SLOT_LOCK_FILE,
} from "./internal/layout";
export type {
  DrainRecord,
  SlotHolder,
  SlotHolderKind,
  SlotLeaseMode,
  UnservedStamp,
} from "./internal/layout";
