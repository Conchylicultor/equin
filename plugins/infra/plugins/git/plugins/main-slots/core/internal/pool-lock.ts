import { AsyncLocalStorage } from "node:async_hooks";
import { mkdir } from "node:fs/promises";
import { openOwnedFd } from "@plugins/packages/plugins/owned-fd/core";
import { flockTry, waitForFlock } from "@plugins/packages/plugins/flock/core";
// This plugin's own declaration — a host-only `core/` reading its own
// `data-dirs` (a `runtimeExceptions` line in the boundary config).
import { mainSlotsDataDir } from "../../data-dirs";

// The POOL lock: one exclusive flock over the whole pool, held by every step
// that reads slot states and acts on them — picking or publishing a build's slot,
// handing it over, flipping a `current` link and stamping what it left,
// turning a build's lease shared, reclaiming. Each of those is a read-then-act
// on several slots at once (a slot's own lock covers only its code): without
// one lock over them, a reclaim renaming a free slot away lands between
// another process listing the slot and reading it, and a probe of a slot's
// lock (`slotStates`) lands in a downgrade's gap. Short holds only: nothing
// under it waits for another process to let a slot go.

/** The lock file, in the pool dir — a dot name, so no listing reads it as a slot. */
const POOL_LOCK_FILE = ".pool.lock";

const holding = new AsyncLocalStorage<true>();

/**
 * Run `fn` holding the pool lock. Re-entrant within one async flow (a locked
 * step calling another), so the locked steps compose; two flows of one
 * process exclude each other like two processes do.
 */
export async function withSlotPool<T>(fn: () => Promise<T>): Promise<T> {
  if (holding.getStore() === true) return fn();
  await mkdir(mainSlotsDataDir.path, { recursive: true });
  const path = mainSlotsDataDir.file(POOL_LOCK_FILE);
  const fd = await openOwnedFd(path, "a");
  let release: () => Promise<void>;
  if (flockTry(fd.fd)) {
    release = () => {
      // Closing the descriptor drops the lock.
      if (!fd.closed) fd.close();
      return Promise.resolve();
    };
  } else {
    fd.close();
    const held = await waitForFlock(path);
    release = () => held.release();
  }
  try {
    return await holding.run(true, fn);
  } finally {
    await release();
  }
}
