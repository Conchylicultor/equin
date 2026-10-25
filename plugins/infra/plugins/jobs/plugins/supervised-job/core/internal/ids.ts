/**
 * The two identifiers that become filenames.
 *
 * A supervised run's two artifacts are both named `<kindId>-<runId>` plus a
 * suffix, in one shared directory (`worktreeArtifacts.runTranscript` /
 * `runTerminal` own the suffixes), so both halves are validated at the boundary
 * rather than trusted. There are two distinct things to stop, and they need
 * different rules.
 */

/**
 * A kind id: lowercase letters and digits, no separator at all.
 *
 * The ban on `-` is the load-bearing part, and it is not stylistic. The prune
 * names a kind's family by the prefix `<kindId>-`, so if `deploy` and
 * `deploy2` were both kinds, `deploy2-abc.log` would parse as run `2-abc` of
 * kind `deploy` — and pruning `deploy` would reap `deploy2`'s transcripts. With
 * no separator inside a kind id, the FIRST `-` in a filename is always the
 * kind/run boundary and the families are disjoint by construction.
 */
const KIND_ID = /^[a-z][a-z0-9]*$/;

/**
 * A run id: the caller's own id, so the rule only excludes what a filename
 * cannot survive — a separator, a traversal, whitespace. Build's
 * `build-<ms>-<rand>` and release's `rel-<…>` both pass unchanged.
 */
const RUN_ID = /^[A-Za-z0-9._-]+$/;

export function assertRunKindId(id: string): void {
  if (!KIND_ID.test(id)) {
    throw new Error(
      `[supervised-run] invalid kind id ${JSON.stringify(id)} — a kind id is ` +
        `lowercase alphanumeric with no separator (it becomes the filename ` +
        `prefix that keeps one kind's artifacts out of another's prune).`,
    );
  }
}

/**
 * Whether `runId` can name a run: one non-empty filename segment of letters,
 * digits, `.`, `_` and `-` — never `.` or `..`, which pass the character class
 * but name a directory. The predicate a reader holding an id from outside (a
 * URL, a ledger row of an older shape) checks before joining it into a path.
 */
export function isRunId(runId: string): boolean {
  return RUN_ID.test(runId) && runId !== "." && runId !== "..";
}

export function assertRunId(kindId: string, runId: string): void {
  if (!isRunId(runId)) {
    throw new Error(
      `[supervised-run] ${kindId}: invalid run id ${JSON.stringify(runId)} — ` +
        `a run id becomes a filename, so it must be non-empty and made of ` +
        `letters, digits, ".", "_" and "-".`,
    );
  }
}
