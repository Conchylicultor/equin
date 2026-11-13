/**
 * How shared work runs: in a scope that counts it under `name`, never into
 * the unit (a check, a request) whose call happened to start it.
 */
export type SharedWorkScope = <T>(name: string, fn: () => T) => T;

const runDirectly: SharedWorkScope = (_name, fn) => fn();
let scope: SharedWorkScope = runDirectly;

/**
 * Run `fn` as SHARED work: work one caller starts and every later caller
 * reuses — a per-process memo (the plugin tree a check pass builds once), a
 * record a content-keyed store keeps. Which caller starts it is an accident
 * of order (and of what the store already held), so a per-unit meter must
 * not charge it to that caller: whatever the installed scope meters (the
 * file calls, `packages/timed-fs`) is counted under `name` instead.
 *
 * Wrap the producer where the memo is filled (`cached ??= sharedWork(…)`),
 * so the work's whole promise chain runs in the scope. With no scope
 * installed — a process that meters nothing, a browser — it runs `fn`.
 */
export function sharedWork<T>(name: string, fn: () => T): T {
  return scope(name, fn);
}

/**
 * Install the scope shared work runs in — once, by the meter that counts it
 * (`packages/timed-fs`, as it loads: a file call cannot be counted before the
 * module that counts it is loaded, so nothing it would count runs earlier).
 */
export function installSharedWorkScope(next: SharedWorkScope): void {
  scope = next;
}

/**
 * Inputs owned by ONE unit: a memo keyed on one of them serves that unit
 * alone (an input-keyed check's recording file set — `ctx.repo()` records
 * its reads into that check's read-set), so the work it does is that unit's
 * own, never shared.
 */
const ownedByOneUnit = new WeakSet<object>();

/** Mark `input` as one unit's own: work memoized on it is counted as that unit's. */
export function markOwnInput(input: object): void {
  ownedByOneUnit.add(input);
}

/** Whether `input` is one unit's own (see {@link markOwnInput}). */
export function isOwnInput(input: object): boolean {
  return ownedByOneUnit.has(input);
}

/**
 * Run `fn` as work over `input`: shared work ({@link sharedWork}`(name, …)`)
 * unless `input` is one unit's own ({@link markOwnInput}), in which case it is
 * that unit's work and runs in its scope. For work a memo hung off an input
 * does lazily (a scan a context runs on first ask).
 */
export function sharedWorkOver<T>(input: object, name: string, fn: () => T): T {
  return isOwnInput(input) ? fn() : sharedWork(name, fn);
}

/**
 * A memo of work keyed by an input object (a run's file set, a codegen pass
 * over one): `produce(key, ...args)` runs once per key — with the first
 * caller's `args` — and is shared work by construction: run under
 * {@link sharedWork}`(name, …)`, so whichever unit asks first is not charged
 * for it, unless the key's owner (the key itself, or `owner(key)`: the file
 * set a pass is over) is one unit's own input ({@link markOwnInput}), in which
 * case it IS that unit's work and runs in its scope.
 *
 * The one spelling of a per-run memo: a hand-rolled `WeakMap` / `Map` keyed by
 * a run's file set is a lint error (`shared-work-safety/per-run-memo`), so no
 * memo can forget the scope and charge a whole tree's reads to one check.
 */
export function sharedMemo<K extends object, A extends unknown[], V>(
  name: string,
  produce: (key: K, ...args: A) => V,
  opts?: { owner?: (key: K) => object },
): (key: K, ...args: A) => V {
  const memo = new WeakMap<K, V>();
  return (key, ...args) => {
    if (memo.has(key)) return memo.get(key) as V;
    const value = sharedWorkOver(opts?.owner?.(key) ?? key, name, () =>
      produce(key, ...args),
    );
    memo.set(key, value);
    return value;
  };
}
