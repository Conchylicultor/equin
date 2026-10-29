import { defineHostPool } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import {
  HOST_POOLS,
  type HostPoolId,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { isConnectionCapacityRefusal } from "@plugins/database/plugins/connection/core";
import { SUPERVISED_EXIT_TEMPFAIL } from "../../core";

/**
 * The `--admit <pool>` value, checked: it travels on a command line, so it is
 * untrusted again here, and a pool the table does not declare has no slot
 * files — refused loudly rather than booting unbounded.
 */
export function parseAdmissionPool(raw: string): HostPoolId {
  if (!Object.hasOwn(HOST_POOLS, raw)) {
    throw new Error(
      `[supervised-exec] --admit ${JSON.stringify(raw)} names no host pool. ` +
        `Declared pools: ${Object.keys(HOST_POOLS).join(", ")}.`,
    );
  }
  return raw as HostPoolId;
}

/**
 * Take a slot of `poolId` and only then `boot` — holding the slot for the rest
 * of the process, since `boot` (`runExec`) never returns: the kernel releases
 * the flock when the process exits, however it exits.
 *
 * Before boot, on purpose: what the pool bounds is the booted child — its
 * database connections through the host-wide pgbouncer and its graph's memory —
 * so a child waiting here holds neither. Its run's row is already open, so
 * whoever waits on the run sees it running and keeps waiting.
 */
export async function admitThenBoot(
  poolId: HostPoolId,
  boot: () => Promise<never>,
  log: (line: string) => void,
): Promise<never> {
  const pool = defineHostPool({
    id: poolId,
    size: HOST_POOLS[poolId].size,
    // Nobody spawns through the slot: the holder IS this process.
    holder: "inherit",
  });
  log(
    `[supervised-exec] waiting for a ${poolId} slot (${String(pool.size)} host-wide) before booting`,
  );
  return pool.run(() => boot(), {
    onAcquired: (waitMs) =>
      log(
        `[supervised-exec] admitted to ${poolId} after ${String(Math.round(waitMs))} ms`,
      ),
  });
}

/**
 * The exit status of a failed child: EX_TEMPFAIL when the database refused a
 * connection because it was full — the one failure a child cannot record on
 * its row, and the one its waiter should retry later rather than count — and
 * 1 for everything else.
 */
export function supervisedChildExitCode(err: unknown): number {
  return isConnectionCapacityRefusal(err) ? SUPERVISED_EXIT_TEMPFAIL : 1;
}
