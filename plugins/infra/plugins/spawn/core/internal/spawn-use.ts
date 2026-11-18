/** How a captured child is run (as is, until one is installed). */
type SpawnUse = <T>(start: () => Promise<T>) => Promise<T>;
let spawnUse: SpawnUse = (start) => start();

/**
 * Install how every `spawnCaptured` child is run — a backend's
 * `usingSlot("spawn", start)` (`packages/semaphore`): a child started by a live
 * read holds a slot of the runtime's `read-spawn` gate for its whole life, so
 * a reconnect herd cannot fork more than that gate's worth of children at once
 * — while waiting on a child holds no read-admit slot. One per process; this
 * leaf-ish core (imported by every CLI) does not import the gate's owner.
 */
export function installSpawnUse(wrap: SpawnUse): void {
  spawnUse = wrap;
}

/** Run `start` — one child, from its temp dir to its reap — as a spawn use. */
export function runSpawnUse<T>(start: () => Promise<T>): Promise<T> {
  return spawnUse(start);
}
