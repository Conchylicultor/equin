export {
  HOLDER_QUIET_MS,
  STALL_WAIT_MS,
  installGrantHooks,
  judgeHolder,
  reportHostGrantWait,
  reportLockWait,
  stallWords,
} from "./internal/holder";
export type { OpenInstallWait } from "./internal/holder";
