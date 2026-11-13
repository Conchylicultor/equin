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
