import type { ServerPluginDefinition } from "@plugins/framework/plugins/server-core/core";

export { defineHostPool, hostOccupancy } from "./internal/pool";
export type { HostPool, HostPoolSpec, PoolOccupancy } from "./internal/pool";
export type {
  ForegroundSlot,
  InheritSlot,
  PoolHolder,
  Slot,
} from "./internal/slot";
export {
  cpuPool,
  e2ePool,
  withHostGrant,
  withE2eGrant,
  inheritedGrant,
} from "./internal/grant";
export { pushPool, repoPushLock } from "./internal/push";
export type { RepoPushLock } from "./internal/push";
// The pure `Grant` TYPE lives in `../core` (both runtimes share it); consumers
// import it from there. Only the runtime impl (`withHostGrant`/`inheritedGrant`)
// lives here.

export default {
  description:
    "Host-admission registry: one place a host-wide concurrency pool comes into existence, wrapping createHostSemaphore with a summed CPU/RAM ceiling and true host occupancy.",
} satisfies ServerPluginDefinition;
