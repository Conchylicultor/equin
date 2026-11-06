// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: every export wraps
// `node:fs` or `Bun.Glob`. Never import it from `web/`.
export {
  readFile,
  readdir,
  stat,
  lstat,
  access,
  exists,
  realpath,
  readlink,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  accessSync,
  existsSync,
  realpathSync,
  readlinkSync,
  scanGlob,
  scanGlobSync,
  onSlowFsCall,
  installFsAwait,
  installFsCallGuard,
  FS_WAIT_FLOOR_MS,
  FS_WAIT_LAYERS,
  TIMED_FS_CALLS,
} from "./internal/timed-fs";
export type { FsWaitLayer, SlowFsCall } from "./internal/timed-fs";
