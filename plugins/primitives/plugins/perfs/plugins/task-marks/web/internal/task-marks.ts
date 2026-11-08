/**
 * What a task about to run says about itself: `what` it is at the grain a
 * recurring freeze is grouped by (`update tasks.v2:rows`), and the `detail`
 * that tells this one apart (its params, its size) — never grouped on.
 */
export interface TaskMarkText {
  readonly what: string;
  readonly detail: string;
}

/**
 * Hears every outermost marked task: `begin` before it runs (`describe` is
 * called only if the listener keeps the mark), `end` once it — and the
 * microtasks it queued itself — ran. `end` gets back what `begin` returned, so
 * a deferred end can never close a later task's mark.
 */
export interface TaskMarkListener {
  begin(source: string, describe: () => TaskMarkText): number | null;
  end(token: number | null): void;
}

let listener: TaskMarkListener | null = null;
let depth = 0;

/**
 * Run `fn` as a marked task (a socket frame's handler, a queue's runner): the
 * listener hears it begin before `fn` runs and end one microtask after it
 * returns or throws — so the microtasks `fn` queued run inside the mark (LoAF
 * counts them in the entry point's script time too). A thread that freezes in
 * between never sends the end: the mark left open is what it froze in.
 *
 * A marked task inside another adds nothing (only the outermost is heard).
 * With no listener, this is `fn()` — `describe` never runs — so an entry point
 * that runs per frame can always be marked.
 */
export function runMarked<T>(
  source: string,
  describe: () => TaskMarkText,
  fn: () => T,
): T {
  const l = listener;
  if (l === null || depth > 0) return fn();
  const token = l.begin(source, describe);
  depth++;
  try {
    return fn();
  } finally {
    depth--;
    queueMicrotask(() => l.end(token));
  }
}

/**
 * Install THE listener (one at a time: a second is a wiring bug, refused
 * loudly). Returns its uninstall.
 */
export function onTaskMark(l: TaskMarkListener): () => void {
  if (listener !== null)
    throw new Error("task-marks: a listener is already installed");
  listener = l;
  return () => {
    if (listener === l) listener = null;
  };
}
