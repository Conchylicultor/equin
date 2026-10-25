// Minimal shape of the (still-experimental) Scheduler API we feature-detect on
// `globalThis.scheduler`. Typed narrowly so no `any` leaks.
interface SchedulerLike {
  /** Yields to the event loop, resolving in a fresh macrotask. */
  yield?: () => Promise<void>;
}

// `setImmediate` is a Node/Bun global the browser lacks, and this is a `core`
// module either runtime may import — so it is read off `globalThis` and typed
// here rather than assumed from ambient types.
interface YieldGlobals {
  scheduler?: SchedulerLike;
  setImmediate?: (callback: () => void) => unknown;
}

/**
 * Resolve on a LATER event-loop turn, so timers and I/O callbacks that are
 * waiting run before the caller continues: `scheduler.yield()` where the
 * runtime has it, else `setImmediate`, else `setTimeout(0)`.
 *
 * NOT `await Promise.resolve()`. A microtask runs before the loop moves on, so
 * a timer that is due keeps waiting through any number of microtask yields: the
 * loop looks cooperative and is not.
 *
 * Callers that yield at the same moment resume together, back to back in the
 * same turn. When each of N concurrent tasks has a long slice ahead of it, use
 * `createTurnQueue()`.
 */
export function yieldMacrotask(): Promise<void> {
  const { scheduler, setImmediate: immediate } = globalThis as YieldGlobals;
  if (scheduler?.yield) return scheduler.yield();
  if (immediate) {
    return new Promise((resolve) => {
      immediate(() => resolve());
    });
  }
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * A queue of event-loop turns: every call resolves on a turn of its own, in
 * call order, with at least one full loop turn — timers, I/O callbacks —
 * between one caller resuming and the next.
 *
 * It exists because `yieldMacrotask()` separates a caller from its own past,
 * not from its peers: N tasks that yield at once are queued for the same turn
 * and resume back to back in it. Here a call's yield is queued only once the
 * previous call's turn has arrived — from inside that turn — so it can only
 * land on a later one.
 *
 * The check runner starts every check through one, so ~100 checks' synchronous
 * start-ups are spread over ~100 turns instead of run as one block.
 */
export function createTurnQueue(): () => Promise<void> {
  let last: Promise<void> = Promise.resolve();
  return () => {
    last = last.then(yieldMacrotask);
    return last;
  };
}

/**
 * A time-sliced yield for a long synchronous loop on a shared thread: each call
 * returns a promise that yields a macrotask (`yieldMacrotask`) only once
 * `budgetMs` of wall time has passed since the last yield, and resolves at once
 * otherwise — so a loop over thousands of cheap items pays for a yield about
 * every `budgetMs`, not per item.
 *
 * ```ts
 * const slice = createTimeSlicer();
 * for (const file of files) {
 *   await slice();
 *   scan(file);
 * }
 * ```
 *
 * One slicer per loop (or per task): the budget is the caller's own run time
 * since ITS last yield.
 *
 * `yieldTurn` is how it yields. When many tasks of one kind slice at once (every
 * transcript a server boot opens), pass them one shared `createTurnQueue()`: each
 * task's next slice then waits for a turn of its own, instead of all of them
 * resuming back to back in one turn — N × the budget with no timer in between.
 */
export function createTimeSlicer(
  budgetMs = 10,
  yieldTurn: () => Promise<void> = yieldMacrotask,
): () => Promise<void> {
  let lastYield = performance.now();
  return async () => {
    if (performance.now() - lastYield <= budgetMs) return;
    await yieldTurn();
    lastYield = performance.now();
  };
}
