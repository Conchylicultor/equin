import {
  spawnCaptured,
  type SpawnOptions,
  type SpawnResult,
} from "@plugins/infra/plugins/spawn/core";

/**
 * The scheduling tier a pool's HOLDER does its held work in.
 *
 * - `foreground` — the pool is a bottleneck others queue on, so its holder's
 *   work starts out of darwinbg. Every queued holder waits out the hold, so a
 *   holder demoted to the E-cores stretches every wait behind it (the push
 *   lock: normalize 109 s → 13 s once its holder ran in the foreground).
 * - `inherit` — the holder's work runs in whatever tier its spawner chose,
 *   as before. For a pool nobody measurably waits on, or one that IS the fleet
 *   (the elastic `cpu` pool — lifting it would lift every agent).
 */
export type PoolHolder = "foreground" | "inherit";

/** `SpawnOptions` without `tier` — distributed over its bound union. */
type UntieredSpawnOptions = SpawnOptions extends infer O
  ? O extends unknown
    ? Omit<O, "tier">
    : never
  : never;

/**
 * A held slot of a `holder: "foreground"` pool. `spawn` is `spawnCaptured`
 * at the `foreground` tier, and takes no tier: a holder of a scarce slot has no
 * spelling for starting its work demoted.
 */
export interface ForegroundSlot {
  readonly holder: "foreground";
  spawn(argv: string[], opts: UntieredSpawnOptions): Promise<SpawnResult>;
}

/** A held slot of a `holder: "inherit"` pool: `spawnCaptured` as the caller asks. */
export interface InheritSlot {
  readonly holder: "inherit";
  spawn(argv: string[], opts: SpawnOptions): Promise<SpawnResult>;
}

/** The slot a pool of holder tier `H` hands its holder. */
export type Slot<H extends PoolHolder = PoolHolder> = H extends "foreground"
  ? ForegroundSlot
  : InheritSlot;

/** The slot capability a pool of holder tier `holder` hands its holder. */
export function slotFor<H extends PoolHolder>(holder: H): Slot<H> {
  const slot: ForegroundSlot | InheritSlot =
    holder === "foreground"
      ? {
          holder: "foreground",
          // `tier` last: a cast-smuggled tier cannot override it.
          spawn: (argv, opts) =>
            spawnCaptured(argv, { ...opts, tier: "foreground" }),
        }
      : { holder: "inherit", spawn: spawnCaptured };
  return slot as Slot<H>;
}
