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

export default [...byId.values()];
