import { readEnv } from "@plugins/infra/plugins/launcher/plugins/env-names/core";

/**
 * Whether a spawn from THIS process should be disclaimed: on macOS, unless
 * `EQUIN_NO_SPAWN_DISCLAIM=1` (the operator escape hatch: `1` turns the
 * disclaim off everywhere). The caller that resolves the helper asks
 * this first, so a disabled or non-macOS host never builds or waits for it.
 */
export function spawnDisclaimWanted(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return platform === "darwin" && readEnv("NO_SPAWN_DISCLAIM", env) !== "1";
}

/**
 * The argv that runs `argv` as its own responsible process: `[helper, …argv]`
 * — the helper execs `argv[0]` in place (same pid, stdio and signals) with its
 * responsibility disclaimed. `argv` unchanged when there is no helper (not
 * built, not requested) or the disclaim is not wanted here.
 */
export function disclaimArgv(
  helper: string | null,
  argv: readonly [string, ...string[]],
  wanted: boolean = spawnDisclaimWanted(),
): [string, ...string[]] {
  return helper !== null && wanted ? [helper, ...argv] : [...argv];
}
