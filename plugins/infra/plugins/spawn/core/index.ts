// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: this barrel reaches
// `node:fs` / `node:path`. It lives in `core/` so every non-web runtime — the
// CLI, the check runner (whose `core → core` isolation puts `server/` out of
// reach), and later the servers — hits the sanctioned wedge-proof spawn
// chokepoint instead of hand-rolling piped stdio. This plugin must NEVER be
// imported from `web/`.

export type {
  ChildResourceUsage,
  SpawnBaseOptions,
  SpawnBound,
  SpawnOptions,
  SpawnResult,
  SpawnedChild,
  SpawnPassthroughOptions,
  SpawnPassthroughResult,
  SpawnToFileOptions,
} from "./internal/types";
export {
  spawnCaptured,
  spawnExpectOk,
  SpawnFailedError,
} from "./internal/spawn-captured";
export { spawnPassthrough, spawnToFile } from "./internal/spawn-passthrough";
export { getWorktreeRoot, getMainRepoRoot } from "./internal/git-roots";
