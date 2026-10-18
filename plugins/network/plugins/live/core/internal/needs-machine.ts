import type { MachineFeature } from "@plugins/infra/plugins/endpoints/core";

// `needsMachine` on a live declaration — a read only the desktop app's own
// server can answer (it reads the computer: a checkout, a process, the host).
// The same per-declaration pattern as `OriginField`: the declaration's TYPE
// says which kind it is, so `serveValue` / `serveCollection` from `live/server`
// take only a portable one, `live/machine`'s only a machine one (tsc), and a
// `useLive` read of a machine one adds the `unavailable` arm a reader must
// handle. Proposal: research/2026-10-18-global-portable-server-machine-split.md §1d.

/** The `needsMachine` field every `liveValue` / `liveCollection` spec form takes. */
export interface LiveMachineSpec<M extends MachineFeature | undefined> {
  /**
   * Declared: only a plugin's `machine/` half serves this read, and a reader
   * under a transport with no computer behind it gets `unavailable`.
   */
  needsMachine?: M;
}

/** A declaration that needs the computer — what `live/machine` serves. */
export interface LiveMachineDecl {
  readonly needsMachine: MachineFeature;
}

/** A declaration every host can serve — what `live/server` serves. */
export interface LivePortableDecl {
  readonly needsMachine?: undefined;
}

/**
 * What a declaration's `needsMachine` adds to its type (see
 * {@link LiveMachineSpec}): a {@link LiveMachineDecl} when `M` is the feature
 * it was declared with, a {@link LivePortableDecl} when it is `undefined` (none
 * declared). Any other `M` — its whole constraint `MachineFeature | undefined`,
 * or `never` — adds nothing: that is a factory's signature instantiated
 * generically (the resource vocabulary's `(...args: never[]) => infer R` match
 * compares two such instantiations, which must agree), never a declaration.
 */
export type LiveMachineBrand<M> = [M] extends [never]
  ? unknown
  : [undefined] extends [M]
    ? [M] extends [undefined]
      ? LivePortableDecl
      : unknown
    : LiveMachineDecl;

/** The `needsMachine` field a spec carries at runtime, copied onto its descriptor. */
export function machineFields(spec: { needsMachine?: MachineFeature }): {
  needsMachine?: MachineFeature;
} {
  return spec.needsMachine === undefined
    ? {}
    : { needsMachine: spec.needsMachine };
}
