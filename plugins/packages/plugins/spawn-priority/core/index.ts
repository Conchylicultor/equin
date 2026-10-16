// `core/` here means RUNTIME-NEUTRAL NODE, not web-safe: this barrel reaches
// `node:fs` and `bun:ffi`. The tier helpers live in `core/` so runtimes whose
// `core → core` isolation puts `server/` out of reach (the CLI check runner,
// infra/spawn's `core/`) can still compose them — demotion (`backgroundArgv`)
// and the spawn-scoped lift (`spawnInForeground`) alike. `boostInteractiveQos`
// stays server-only. This plugin must NEVER be imported from `web/`.

export { backgroundArgv, backgroundPrefix } from "./internal/background";
export {
  readDarwinBackground,
  spawnInForeground,
  withForegroundPriority,
} from "./internal/darwin-background";
export type { DarwinBackground } from "./internal/darwin-background";
export { spawnAtTier } from "./internal/tier";
export type { SpawnTier } from "./internal/tier";
