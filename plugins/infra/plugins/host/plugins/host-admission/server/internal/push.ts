import { createHostSemaphore } from "@plugins/packages/plugins/host-semaphore/server";
import type { AcquireHooks } from "@plugins/packages/plugins/host-semaphore/server";
import { defineHostPool } from "./pool";
import { slotFor, type ForegroundSlot } from "./slot";

// The global push mutex, folded onto the host-pool primitive. `size 1` ⇒ at most
// one push runs host-wide. Who holds it and who waits on it is read from the op
// log (a push's `push-mutex` wait and its `granted`), not from this lock file.
//
// `holder: "foreground"`: every queued push waits out the holder's whole hold.
// The push already runs that hold in the foreground through its interactive
// grant (`withHostGrant` lifts the process); this states it in the spec.
export const pushPool = defineHostPool({
  id: "push",
  size: 1,
  holder: "foreground",
});

/**
 * The mutex a push of ONE repository other than the installed one takes. Its
 * holder is in the foreground like `pushPool`'s, so it hands the same slot.
 */
export interface RepoPushLock {
  run<T>(
    fn: (slot: ForegroundSlot) => Promise<T>,
    hooks?: AcquireHooks,
  ): Promise<T>;
}

// One handle per repository per process, like the pool registry.
const repoLocks = new Map<string, RepoPushLock>();

/**
 * The push mutex of a repository that is NOT the one this machine's main app is
 * served from — a second clone, an e2e's temp repo. It guards the same thing
 * `pushPool` does (writes to one repository's `main`), scoped to that
 * repository: its slot lives in the repository's own git dir
 * (`<gitCommonDir>/singularity-locks/push/`), so such a push neither queues the
 * machine's real pushes behind its check pass nor waits behind theirs.
 *
 * Declared here, beside `pushPool`, so every push mutex comes from this plugin.
 */
export function repoPushLock(gitCommonDir: string): RepoPushLock {
  const hit = repoLocks.get(gitCommonDir);
  if (hit) return hit;
  const sem = createHostSemaphore({
    slots: { kind: "repo-lock", gitCommonDir, name: "push" },
    size: pushPool.size,
  });
  const slot = slotFor("foreground");
  const lock: RepoPushLock = {
    run: (fn, hooks) => sem.run(() => fn(slot), hooks),
  };
  repoLocks.set(gitCommonDir, lock);
  return lock;
}
