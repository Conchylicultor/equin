import { AsyncLocalStorage } from "node:async_hooks";
import { ChildKilledError } from "./child-killed";

/**
 * Every spawned child that died of a signal while a scope ran — the fact a
 * caller that only checks `exitCode !== 0` (and so reports a plain failure)
 * would otherwise drop. Recorded by the spawn primitives themselves
 * (`spawnCaptured`, `spawnPassthrough`, `spawnToFile`), so nothing that spawns
 * has to remember to: the check runner reads it for each check and turns a
 * failure that saw a kill into `killedBy` (no verdict on the code).
 *
 * Not recorded: a child OUR bound ended — a `timeoutMs` that fired
 * (`timedOut`) is a deadline verdict, and an aborted call throws its reason —
 * nor a first-party child's authored `128 + signo` exit (only its spawner
 * knows its codes are ours; it throws `ChildKilledError` itself).
 */
export interface ChildKillWatch {
  /** The kills seen so far, in the order the children were reaped. */
  readonly kills: readonly ChildKilledError[];
  /** Run `fn` inside the watch: every child it spawns (at any depth of its async calls) is seen. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

interface WatchScope {
  readonly kills: ChildKilledError[];
  readonly parent: WatchScope | undefined;
}

const watchScope = new AsyncLocalStorage<WatchScope>();

/** A new kill watch, nested in (and reporting to) any enclosing one. */
export function watchChildKills(): ChildKillWatch {
  const kills: ChildKilledError[] = [];
  return {
    kills,
    run: (fn) => watchScope.run({ kills, parent: watchScope.getStore() }, fn),
  };
}

/**
 * The spawn primitives' hook: a child ended. Records a `ChildKilledError` in
 * every enclosing watch when a signal ended it and our own deadline did not.
 */
export function noteChildEnded(
  argv: readonly string[],
  ended: { signalCode: string | null; timedOut: boolean },
): void {
  if (ended.signalCode === null || ended.timedOut) return;
  const shown = argv.length > 4 ? [...argv.slice(0, 4), "…"] : argv;
  const killed = new ChildKilledError(
    `\`${shown.join(" ")}\``,
    ended.signalCode,
  );
  for (let at = watchScope.getStore(); at !== undefined; at = at.parent)
    at.kills.push(killed);
}
