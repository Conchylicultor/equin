import { defineDataDir, type DataDir } from "@plugins/infra/plugins/paths/core";
import { HOST_POOLS } from "@plugins/infra/plugins/host/plugins/host-admission/core";

// Every host pool's flock slot files, declared HERE rather than derived inside
// the primitive that uses them.
//
// This is the fix for the single worst offender in the old data root:
// `createHostSemaphore` used to do ``join(EQUIN_DIR, `${name}-slots`)``
// itself, so ONE primitive silently minted a top-level directory per pool — ten
// on disk, of which only seven had a live `defineHostPool`. Nothing could see
// that, because the paths existed only as a template literal inside a function.
//
// The pool set is NOT a second list: it is `HOST_POOLS` (the pool table, the one
// place a non-CPU pool is declared) plus `cpu`, which is the elastic fleet and
// therefore never appears in that table. A new pool added to the table gets its
// lock dir here with no edit; a pool that is NOT in the table has no lock dir and
// `defineHostPool` refuses to build it, which is the same structural bar
// `host-budget` already enforces from the other side.

/**
 * The CPU pool's id. It is the elastic fleet, sized from host facts rather than
 * declared, so by construction it is the one pool absent from `HOST_POOLS` —
 * named explicitly here for that reason, not as an exception.
 */
const CPU_POOL_ID = "cpu";

const POOL_IDS: readonly string[] = [CPU_POOL_ID, ...Object.keys(HOST_POOLS)];

function lockDir(id: string): DataDir {
  return defineDataDir({
    kind: "locks",
    name: id,
    owner: "infra/host/host-admission",
    description: `flock slot files bounding the "${id}" host-wide concurrency pool`,
    // The files are pure kernel-lock state: a slot conveys nothing once its
    // holder is gone, and flock releases on process death anyway. Reclaimable
    // the moment nothing on the box is running — never while it is.
    reclaim: { kind: "restart" },
  });
}

const byId = new Map<string, DataDir>(POOL_IDS.map((id) => [id, lockDir(id)]));

/**
 * The lock directory for a host pool, or `undefined` when the id names no
 * declared pool. `defineHostPool` turns the absent case into a loud throw — a
 * pool with no declared slot directory would otherwise be exactly the invisible
 * top-level entry this registry exists to prevent.
 */
export function poolLockDir(id: string): DataDir | undefined {
  return byId.get(id);
}

/**
 * The fleet's measured memory reading (`fleet-memory.json`): main's owner
 * sampler writes it every 30 s, every grant acquire reads it (`fleetWindow`).
 *
 * `locks` like the duress latch beside it: it is a lease, not a record — its
 * `sampledAt` is the signal and it means nothing once the sampler that rewrites
 * it has stopped (`FLEET_MEMORY_LEASE_MS`).
 */
export const fleetMemoryDir = defineDataDir({
  kind: "locks",
  name: "fleet-memory",
  owner: "infra/host/host-admission",
  description:
    "The agent fleet's measured memory reading (RAM, wired, non-op and op footprints, held cpu slots) main's owner sampler leases every 30 s for cpu grant admission",
  reclaim: { kind: "restart" },
});

/**
 * One marker per live `cpu` share (`<pid>-<n>.json`: the holding process, its
 * kind of work, its units), written by `withHostGrant` and flocked for the
 * share's life — the lock is the liveness. Main's owner sampler reads them to
 * measure each holder's process tree and charge it (`fleetCharge`).
 */
export const cpuHoldersDir = defineDataDir({
  kind: "locks",
  name: "cpu-holders",
  owner: "infra/host/host-admission",
  description:
    "One flocked marker per live cpu grant share (holding pid, kind of work, units) — what main's owner sampler measures each holder's process tree by",
  reclaim: { kind: "restart" },
});

/**
 * The holder-peak ledger (`holder-peaks.jsonl` + rotations): per finished
 * `cpu` share, its kind of work, units and the largest footprint its process
 * tree was read at. What each work's reservation is derived from
 * (`holderReserve`).
 */
export const holderPeaksLogDir = defineDataDir({
  kind: "logs",
  name: "cpu-holder-peaks",
  owner: "infra/host/host-admission",
  description:
    "Per finished cpu grant share on this host (`holder-peaks.jsonl` + rotations): its kind of work, units and peak process-tree footprint — what each kind of work's memory reservation is derived from",
  // A record of past holders, not state anything needs to run: lost, every
  // work is reserved the whole quantum per slot again until it re-accrues.
  reclaim: { kind: "safe" },
  logs: [{ pattern: "holder-peaks.jsonl", bound: { kind: "file-sink" } }],
});

export default [
  ...byId.values(),
  fleetMemoryDir,
  cpuHoldersDir,
  holderPeaksLogDir,
];
