// The config dir's whole-directory change signal, fed by the config-files
// watcher (`config-watcher.ts`). Its own module so it carries no `CONFIG_DIR`
// (resolved from the runtime namespace at module eval) and can be driven alone.

const listeners = new Set<() => void>();

/**
 * Hear any `.jsonc` file under the config dir being created, rewritten or
 * removed — whichever descriptor it belongs to, including a file no live
 * descriptor owns (what the orphan audit reports). Once per watcher batch, not
 * per file. Returns the unsubscribe.
 *
 * Same contract as `watchFileChange`: a push-latency signal, not a correctness
 * one (see `config-watcher.ts`'s header). It fires from the watcher, armed in
 * `onReady`, for in-process writes too (they land on disk like any other). A
 * reader derives its answer from the disk, never from "no event".
 */
export function onConfigDirChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * The watcher saw a batch of config-file changes: tell every listener. Each
 * runs even when one throws, and the first failure is rethrown after — one
 * consumer's bug neither starves the others nor vanishes.
 */
export function notifyConfigDirChange(): void {
  let failure: { error: unknown } | null = null;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      failure ??= { error };
    }
  }
  if (failure !== null) throw failure.error;
}
