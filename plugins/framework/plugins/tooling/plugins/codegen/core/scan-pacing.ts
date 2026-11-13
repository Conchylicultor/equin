import { yieldMacrotask } from "@plugins/packages/plugins/macrotask-yield/core";

// How long a scan may run synchronously before it gives the thread back. A check
// pass runs every check on one JS thread, so a parse loop that never yields
// holds up every other check and every timer for its whole length.
const SLICE_MS = 10;

/**
 * A yield budget shared by one scan's parse loops. `await tick()` between units
 * of synchronous work returns at once until ~10 ms have run since the last
 * yield, then yields a MACROTASK, so timers and I/O callbacks run in between.
 *
 * One budget per scan, not per loop: a scan's continuations interleave (several
 * plugins' reads resolve together), and a shared clock is what bounds the run
 * of synchronous work between any two yields.
 */
export function timeSlicer(): () => Promise<void> {
  let since = performance.now();
  return async () => {
    if (performance.now() - since < SLICE_MS) return;
    await yieldMacrotask();
    since = performance.now();
  };
}
