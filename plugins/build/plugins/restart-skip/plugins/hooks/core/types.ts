/**
 * Files a backend reads ONCE (at boot or first use) and holds for its life,
 * which its import closure does not see — the migration SQL it applied. A
 * restart may be skipped only while none of them changed since the process
 * started. A directory counts by its own inode (an entry added, removed or
 * renamed) and by each direct entry's.
 */
export interface BootInput {
  /** What the files are, in words (a refusal names it). */
  what: string;
  /** Absolute paths: files, or directories (non-recursive). */
  paths: readonly string[];
}
