/**
 * Signal every process in group `pgid`; an emptied group is not an error.
 *
 * A leaf (no imports) so both the group's owners can use it — `spawnCaptured`
 * (a bound that fires ends the bounded child's group) and `process-group.ts`
 * (which lists a group through `spawnCaptured`) — without importing each other.
 */
export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}
