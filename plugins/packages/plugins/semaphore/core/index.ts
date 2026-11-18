export { createSemaphore } from "./internal/semaphore";
export type { Semaphore, SlotHolder, SlotOptions } from "./internal/semaphore";
export { installLeaseContextRuntime, usingSlot } from "./internal/lease-scope";
export type {
  LeaseContextRuntime,
  LeaseScope,
  SlotUse,
} from "./internal/lease-scope";
