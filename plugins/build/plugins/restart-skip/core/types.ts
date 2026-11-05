/**
 * Long-lived code a process started and that dies with it — a supervised
 * worker or child (infra/spawn/daemon). A restart respawns it from the new
 * tree; a skipped restart keeps it on the code it was spawned with, so the
 * judgement must vouch for that code too.
 */
export interface ChildIncarnation {
  /** Which one, in words (a refusal names it). */
  label: string;
  /** When it was spawned, ms since the epoch: it loaded its code after. */
  spawnedAtMs: number;
  /**
   * The executable (`null`: this process's own Bun, a worker) and the module
   * files it loads from (`entries: null`, or `code: null`: unknown).
   */
  code: { binary: string | null; entries: readonly string[] | null } | null;
}
