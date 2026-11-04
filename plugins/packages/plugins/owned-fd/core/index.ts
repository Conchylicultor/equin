// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: it wraps `node:fs`.
// Never import it from `web/`.
export {
  adoptFd,
  FdAlreadyClosedError,
  openOwnedFd,
} from "./internal/owned-fd";
export type { OwnedFd } from "./internal/owned-fd";
