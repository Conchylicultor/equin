export { createSemaphore } from "./internal/semaphore";
export type { Semaphore, SlotOptions } from "./internal/semaphore";
export {
  installLeaseContextRuntime,
  whileWaiting,
} from "./internal/lease-scope";
export type { LeaseContextRuntime, LeaseScope } from "./internal/lease-scope";
