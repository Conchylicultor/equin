import { WorktreeGoneError } from "@plugins/primitives/plugins/commit-list/server";
import { editedFilesMemo } from "./edited-files-cache";

/**
 * Hear the worktree's edited-files list change until the returned stop runs.
 * Watchers of one worktree — however many conversations show it — share one
 * checkout watch and one pass per change (`editedFilesMemo`, its passes
 * profiled as `watch-edited-files:pass`); while watched, a read is the held
 * list. Resolves once the watch is live. A worktree that is gone has nothing
 * to watch (the loader answers it `unresolved`), so it resolves to a no-op
 * stop.
 */
export async function watchEditedFiles(
  worktreePath: string,
  onChange: () => void,
): Promise<() => void> {
  try {
    return await editedFilesMemo.watch(worktreePath, onChange);
  } catch (err) {
    if (!(err instanceof WorktreeGoneError)) throw err;
    return () => {};
  }
}
