import { closeSync, openSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import {
  envEntries,
  readEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import { flockTry } from "./flock";

// The PARENT_LIFELINE variable is what a parent hands its child the lifeline
// path in: `holdParentLifeline` (the spawner) writes it, `exitWithParent` (the
// child) reads it.

/** A lifeline the parent holds for one child. */
export interface ParentLifeline {
  /** Merge into the child's environment. */
  env: Record<string, string>;
  /** Drop the lock. Call once the child has exited. */
  release(): void;
}

/**
 * Parent half: create `<dir>/lifeline` and hold an EXCLUSIVE flock on it until
 * `release()` — or until this process dies, SIGKILL included, when the kernel
 * drops it. A child that called `exitWithParent()` dies the moment it is gone.
 *
 * `dir` must be private to this one spawn (the caller's mkdtemp dir), so the
 * non-blocking acquire cannot meet a competitor; failing it means the fd is
 * broken, and that throws rather than spawning an unguarded child.
 */
export function holdParentLifeline(dir: string): ParentLifeline {
  const path = join(dir, "lifeline");
  writeFileSync(path, "");
  const fd = openSync(path, "r");
  if (!flockTry(fd)) {
    closeSync(fd);
    throw new Error(`holdParentLifeline: could not lock fresh file ${path}`);
  }
  return {
    env: envEntries({ PARENT_LIFELINE: path }),
    release: () => closeSync(fd),
  };
}

/**
 * Child half: make this process die with the parent that spawned it through
 * `infra/spawn`, even when that parent is SIGKILLed and runs no cleanup.
 *
 * Arms a worker thread that blocks on the parent's lifeline lock and SIGKILLs
 * this process once the lock is free (`scripts/lifeline-block.ts`). Works while
 * the main thread is stuck in synchronous work — that is the case it exists for.
 *
 * A no-op when no lifeline was handed down (run by hand, or by a spawner
 * outside the chokepoint), so a script stays runnable standalone.
 *
 * The worker is unref'd, but it parks in a blocking FFI call: end the process
 * with an explicit `process.exit()` rather than by draining the event loop.
 */
export function exitWithParent(): void {
  const file = readEnv("PARENT_LIFELINE");
  if (!file) return;
  // A grandchild must not inherit OUR parent's lifeline: it is guarded by its
  // own spawn's lifeline, or by nothing.
  unsetEnv("PARENT_LIFELINE");
  const worker = new Worker(
    join(import.meta.dir, "../../scripts/lifeline-block.ts"),
    { workerData: { file } },
  );
  worker.unref();
  worker.on("error", (err) => {
    throw err;
  });
}
