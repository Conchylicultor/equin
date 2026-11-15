/**
 * What a signal sent to a whole process group reached:
 *
 * - `signalled` — at least one member received it.
 * - `empty` — the group has no members (ESRCH).
 * - `none-signallable` — the group HAS members but none of them may be
 *   signalled (EPERM). For the groups this plugin creates (our own
 *   descendants, our uid) that means every member is a ZOMBIE: macOS counts a
 *   dead-but-unreaped process as a group member yet refuses to signal it, so
 *   `kill(-pgid, …)` on a group of zombies answers EPERM, not ESRCH (measured
 *   on Darwin 25, 2026-11-15). A zombie has already exited — there is nothing
 *   left to end — but a caller that can list the group (`endProcessGroup`)
 *   checks that rather than assuming it.
 */
export type GroupSignalOutcome = "signalled" | "empty" | "none-signallable";

/**
 * Signal every process in group `pgid` (signal `0` probes without signalling).
 *
 * A leaf (no imports) so both the group's owners can use it — `spawnCaptured`
 * (a bound that fires ends the bounded child's group) and `process-group.ts`
 * (which lists a group through `spawnCaptured`) — without importing each other.
 */
export function signalProcessGroup(
  pgid: number,
  signal: NodeJS.Signals | 0,
): GroupSignalOutcome {
  try {
    process.kill(-pgid, signal);
    return "signalled";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "empty";
    if (code === "EPERM") return "none-signallable";
    throw err;
  }
}

/**
 * Signal every process in group `pgid` to end it. An emptied group, or one
 * whose only members are zombies (already dead, see `none-signallable`), has
 * nothing left to end and is not an error.
 */
export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
  signalProcessGroup(pgid, signal);
}
