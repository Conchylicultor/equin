import { backgroundArgv } from "./background";
import { spawnInForeground, type NotPromise } from "./darwin-background";

/**
 * The scheduling tier a spawned child starts in.
 *
 * - `background` — demoted: `backgroundArgv` prefixes `taskpolicy -b`.
 * - `inherit` — whatever tier the spawning process is in. Inside an agent
 *   session that is darwinbg too, whether or not anything asked for it.
 * - `foreground` — out of darwinbg even when the spawning process is in it
 *   (`spawnInForeground`), never prefixed. For a scarce slot's holder.
 */
export type SpawnTier = "background" | "inherit" | "foreground";

/**
 * Start a child at `tier`: the one place a tier becomes an argv prefix or a
 * lift. `spawn` is the synchronous spawn call (`Bun.spawn`), handed the argv
 * to run; for `foreground` it runs inside `spawnInForeground`, so it must not
 * return a promise.
 */
export function spawnAtTier<T>(
  tier: SpawnTier,
  argv: string[],
  spawn: (argv: string[]) => NotPromise<T>,
): T {
  switch (tier) {
    case "background":
      return spawn(backgroundArgv(argv)) as T;
    case "inherit":
      return spawn(argv) as T;
    case "foreground":
      return spawnInForeground<T>(() => spawn(argv));
  }
}
