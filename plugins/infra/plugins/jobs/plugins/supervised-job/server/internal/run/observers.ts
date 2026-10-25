/**
 * Who wants to hear that one run's artifacts moved — its transcript grew, or it
 * ended — without opening a watch of its own on the runs directory.
 *
 * The supervisor already follows that directory with ONE `writesWhileOpen`
 * subscription (kqueue on darwin: one descriptor per entry) for every live run,
 * and already knows the two moments a reader of a run's files cares about: the
 * tail published new lines, and the run settled (its marker landed, or it was
 * written off as a hard kill). A reader that opened its own subscription on the
 * same directory would pay a second descriptor per entry and a second
 * recursive listing per reader, and — unlike the supervisor's own — would not
 * be held outside the artifact prune, whose delete mid-subscribe fails the
 * whole subscribe (`pruneOutsideWatcherStart`). So the supervisor hands its
 * moments out instead, and a reader's cost is one entry in a map.
 *
 * A run this process is not tailing (finished before the listener was added,
 * or never started here) is silent: its transcript and marker no longer change,
 * so there is nothing to hear.
 */
const listeners = new Map<string, Set<() => void>>();

const observerKey = (kindId: string, runId: string): string =>
  `${kindId}:${runId}`;

/**
 * Call `onChange` each time run `(kindId, runId)`'s transcript publishes new
 * lines or the run settles; returns the stop. Synchronous, and opens nothing.
 */
export function onSupervisedRunChange(
  kindId: string,
  runId: string,
  onChange: () => void,
): () => void {
  const key = observerKey(kindId, runId);
  let set = listeners.get(key);
  if (set === undefined) {
    set = new Set();
    listeners.set(key, set);
  }
  // Wrapped, so one callback registered twice is two registrations, each
  // stopped by its own stop.
  const entry = (): void => onChange();
  set.add(entry);
  return () => {
    const current = listeners.get(key);
    if (current === undefined) return;
    current.delete(entry);
    if (current.size === 0) listeners.delete(key);
  };
}

/** Tell every listener of one run that its artifacts moved. */
export function announceRunChange(kindId: string, runId: string): void {
  const set = listeners.get(observerKey(kindId, runId));
  if (set === undefined) return;
  for (const listener of [...set]) listener();
}
