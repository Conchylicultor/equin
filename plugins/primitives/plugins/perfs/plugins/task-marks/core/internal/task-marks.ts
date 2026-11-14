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
 * Hears which marked task the thread is in: `begin` before it runs
 * (`describe` is called only if the listener keeps the mark), `end` once it —
 * and, for an outermost task, the microtasks it queued itself — ran. `end`
 * gets back what `begin` returned, so a deferred end can never close a later
 * task's mark.
 *
 * At most ONE mark is open at a time — the innermost task running now: a
 * nested task's `begin` describes the whole chain (`outer > inner`, the
 * outermost task's source), and once it returns the task around it is begun
 * again (its earlier token ended) — so a listener that keeps only the latest
 * open mark always holds the task the thread is in.
 */
export interface TaskMarkListener {
  begin(source: string, describe: () => TaskMarkText): number | null;
  end(token: number | null): void;
}

/** A marked task running now, on the stack of the ones around it. */
interface Frame {
  readonly listener: TaskMarkListener;
  /** The outermost task's source: the entry point every mark of the chain is begun under. */
  readonly rootSource: string;
  /** This task's own source — a nested segment from another names it. */
  readonly source: string;
  /** The chain's text up to this task, computed once on first need. */
  readonly text: () => TaskMarkText;
  /** The open mark's token: replaced each time the task is begun again. */
  token: number | null;
}

let listener: TaskMarkListener | null = null;
const stack: Frame[] = [];

function once(f: () => TaskMarkText): () => TaskMarkText {
  let v: TaskMarkText | null = null;
  return () => (v ??= f());
}

/**
 * `parent > own`: a segment from another source than the one before it is
 * named `source:what`; the detail is the innermost task's own (it tells the
 * occurrence apart), else the nearest one around it.
 */
function chained(
  parent: Frame,
  source: string,
  own: TaskMarkText,
): TaskMarkText {
  const p = parent.text();
  const seg = source === parent.source ? own.what : `${source}:${own.what}`;
  return {
    what: `${p.what} > ${seg}`,
    detail: own.detail !== "" ? own.detail : p.detail,
  };
}

/**
 * Run `fn` as a marked task (a socket frame's handler, a queue's runner): the
 * listener hears it begin before `fn` runs and end one microtask after it
 * returns or throws — so the microtasks `fn` queued run inside the mark (LoAF
 * counts them in the entry point's script time too). A thread that freezes in
 * between never sends the end: the mark left open is what it froze in.
 *
 * Inside another marked task, the mark names the chain (`outer > inner`) and
 * ends as soon as `fn` returns, the outer task begun again at once: a freeze
 * after it, still inside the outer task, is the outer's. With no listener,
 * this is `fn()` — `describe` never runs — so an entry point that runs per
 * frame can always be marked.
 */
export function runMarked<T>(
  source: string,
  describe: () => TaskMarkText,
  fn: () => T,
): T {
  const l = listener;
  if (l === null) return fn();
  const top = stack.at(-1);
  // A task begun under another listener (one installed mid-task) is not this
  // one's to chain onto: this task is outermost for it.
  const parent = top?.listener === l ? top : undefined;
  const own = once(describe);
  const frame: Frame = {
    listener: l,
    rootSource: parent?.rootSource ?? source,
    source,
    text: parent ? once(() => chained(parent, source, own())) : own,
    token: null,
  };
  frame.token = l.begin(frame.rootSource, frame.text);
  stack.push(frame);
  try {
    return fn();
  } finally {
    stack.pop();
    const token = frame.token;
    if (parent) {
      l.end(token);
      parent.token = l.begin(parent.rootSource, parent.text);
    } else {
      queueMicrotask(() => l.end(token));
    }
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
