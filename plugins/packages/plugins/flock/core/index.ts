// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: the binding is
// `bun:ffi`. It lives in `core/` so a `shared/` or CLI module can take a lock
// without reaching a `server` barrel. Never import it from `web/`.
export { flockTry, flockRelease } from "./internal/flock";
export { waitForFlock } from "./internal/wait";
export type { HeldFlock, WaitForFlockOptions } from "./internal/wait";
export type { ParentLifeline } from "./internal/lifeline";
export {
  exitWithParent,
  holdParentLifeline,
  PARENT_LIFELINE_ENV,
} from "./internal/lifeline";
