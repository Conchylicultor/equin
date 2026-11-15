import { defineHostPool } from "@plugins/infra/plugins/host/plugins/host-admission/server";
import {
  HOST_POOLS,
  type HostPoolId,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { isConnectionCapacityRefusal } from "@plugins/database/plugins/connection/core";
import {
  SchemaNotReadyError,
  type ExecAdmission,
} from "@plugins/framework/plugins/server-core/core";
import {
  SUPERVISED_EXIT_SCHEMA_NOT_READY,
  SUPERVISED_EXIT_TEMPFAIL,
} from "../../core";

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
 *
 * `boot` is handed the slot as an `ExecAdmission` (`runExec`'s `admission`): a
 * booted child that only waits — for its database's owner to set the schema up
 * for its code, during a deploy — gives the slot back for as long as it waits
 * and queues for one again after (the same rule as the resource runtime's
 * "waiters hold no slot"). Until 2026-11-15 such a child held its slot for the
 * whole wait, so one namespace's deploy starved every namespace's children.
 */
export async function admitThenBoot(
  poolId: HostPoolId,
  boot: (admission: ExecAdmission) => Promise<never>,
  log: (line: string) => void,
): Promise<never> {
  const pool = defineHostPool({
    id: poolId,
    size: HOST_POOLS[poolId].size,
    // Nobody spawns through the slot: the holder IS this process.
    holder: "inherit",
  });
  const take = async (again: boolean): Promise<HeldSlot> => {
    log(
      again
        ? `[supervised-exec] waiting for a ${poolId} slot again (${String(pool.size)} host-wide), the database's schema set up`
        : `[supervised-exec] waiting for a ${poolId} slot (${String(pool.size)} host-wide) before booting`,
    );
    return holdSlot(pool, (waitMs) =>
      log(
        `[supervised-exec] admitted to ${poolId} after ${String(Math.round(waitMs))} ms`,
      ),
    );
  };
  let held: HeldSlot | null = await take(false);
  return boot({
    async release() {
      if (held === null) {
        throw new Error(
          `[supervised-exec] gave the ${poolId} slot back while not holding it`,
        );
      }
      const slot = held;
      held = null;
      await slot.release();
      log(
        `[supervised-exec] gave the ${poolId} slot back while waiting for the database's schema`,
      );
    },
    async reacquire() {
      if (held !== null) {
        throw new Error(
          `[supervised-exec] took a second ${poolId} slot while holding one`,
        );
      }
      held = await take(true);
    },
  });
}

/** What `holdSlot` needs of a host pool: its `run`. */
interface SlotPool {
  run(
    fn: () => Promise<void>,
    hooks: { onAcquired: (waitMs: number) => void },
  ): Promise<void>;
}

/** A held pool slot, until `release` — which resolves once it is free again. */
interface HeldSlot {
  release(): Promise<void>;
}

/**
 * Take one slot of `pool` and hold it past this call: `pool.run` holds a slot
 * for as long as its callback's promise is pending, so the callback hands out
 * the resolve of a promise the caller settles when it lets go.
 */
export function holdSlot(
  pool: SlotPool,
  onAcquired: (waitMs: number) => void,
): Promise<HeldSlot> {
  return new Promise<HeldSlot>((granted, failed) => {
    let letGo: (() => void) | null = null;
    const ran = pool.run(
      () =>
        new Promise<void>((resolve) => {
          letGo = resolve;
          granted({
            release: () => {
              letGo?.();
              return ran;
            },
          });
        }),
      { onAcquired },
    );
    // Before the grant: the acquire failed — the caller is told. After it, the
    // slot's holder is told through `release`'s promise instead.
    ran.catch((err: unknown) => {
      if (letGo === null) failed(err);
    });
  });
}

/**
 * The exit status of a failed child: EX_TEMPFAIL when the database refused a
 * connection because it was full — the one failure a child cannot record on
 * its row, and the one its waiter should retry later rather than count — and
 * `SUPERVISED_EXIT_SCHEMA_NOT_READY` when its database was never set up for its
 * code (the boot's `SchemaNotReadyError`), and 1 for everything else.
 */
export function supervisedChildExitCode(err: unknown): number {
  if (isConnectionCapacityRefusal(err)) return SUPERVISED_EXIT_TEMPFAIL;
  if (err instanceof SchemaNotReadyError)
    return SUPERVISED_EXIT_SCHEMA_NOT_READY;
  return 1;
}
