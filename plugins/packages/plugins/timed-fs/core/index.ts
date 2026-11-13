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
  installFsWaitMeter,
  installFsCallGuard,
  FS_WAIT_FLOOR_MS,
  FS_WAIT_LAYERS,
  TIMED_FS_CALLS,
} from "./internal/timed-fs";
export type { FsWaitLayer, SlowFsCall } from "./internal/timed-fs";
export {
  newFsCallTally,
  processFsCallTally,
  withFsCallTally,
  sharedFsCallTallies,
  snapshotFsCalls,
  fsCallsSince,
  summarizeFsCalls,
  FS_CALL_TOP_PREFIXES,
} from "./internal/fs-call-count";
export type {
  FsCallCounts,
  FsCallSnapshot,
  FsCallSummary,
  FsCallTally,
} from "./internal/fs-call-count";
