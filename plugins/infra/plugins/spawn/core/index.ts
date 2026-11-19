// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: this barrel reaches
// `node:fs` / `node:path`. It lives in `core/` so every non-web runtime — the
// CLI, the check runner (whose `core → core` isolation puts `server/` out of
// reach), and later the servers — hits the sanctioned wedge-proof spawn
// chokepoint instead of hand-rolling piped stdio. This plugin must NEVER be
// imported from `web/`.

export type {
  ChildResourceUsage,
  LeftBehindProcess,
  SpawnBaseOptions,
  SpawnBound,
  SpawnOptions,
  SpawnResult,
  SpawnedChild,
  SpawnGroupResult,
  SpawnPassthroughOptions,
  SpawnPassthroughResult,
  SpawnToFileOptions,
  SpawnWaitDetail,
} from "./internal/types";
export {
  spawnCaptured,
  spawnExpectOk,
  SpawnFailedError,
} from "./internal/spawn-captured";
export { spawnPassthrough, spawnToFile } from "./internal/spawn-passthrough";
export { installSpawnUse } from "./internal/spawn-use";
export { installSpawnWaitMeter } from "./internal/spawn-wait";
export { getWorktreeRoot, getMainRepoRoot } from "./internal/git-roots";
export {
  ChildKilledError,
  killedByOf,
  signalExitCode,
  authoredSignalOf,
  childSignalOf,
} from "./internal/child-killed";
export { watchChildKills } from "./internal/kill-watch";
export type { ChildKillWatch } from "./internal/kill-watch";
