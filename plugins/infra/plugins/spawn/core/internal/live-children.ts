/**
 * The children this process started through the chokepoint and has not yet
 * reaped — SIGTERMed when this process exits, so none outlives it.
 *
 * Why: an op CLI killed with SIGTERM (by a human, an agent, a caller timeout)
 * turns the signal into `process.exit` (`op-runtime`'s `installFatalSignalExit`)
 * and runs its exit hooks — but nothing used to stop the children it was
 * waiting on. A `./equin check` killed that way left its type-check
 * worker running reparented to pid 1 at ~16 GB, its result unread
 * (2026-10-09; research/2026-10-09-infra-spawn-children-die-with-parent.md).
 *
 * Every graceful death ends in `process.on("exit")` — a fatal signal turned
 * into `process.exit`, an uncaught throw, a plain exit after a verdict — so one
 * hook here covers all of them for every caller, with nothing to opt into. A
 * SIGKILLed parent runs no hook at all; that half is the child's own lifeline
 * (`exitWithParent`, `packages/flock`).
 *
 * SIGTERM, not SIGKILL: a child that is itself an op CLI has exit hooks of its
 * own (op marker, op-log terminal) and runs this same reaper over ITS children.
 * There is no escalation — an exit hook cannot wait — so a child that ignores
 * TERM is the lifeline's to catch.
 *
 * Not for supervised or detached children: `defineDaemon` spawns outside these
 * two functions precisely because those outlive any one call.
 */

interface Killable {
  kill(signal: NodeJS.Signals): void;
}

const live = new Set<Killable>();
let reaperInstalled = false;

function reapLiveChildren(): void {
  for (const child of live) child.kill("SIGTERM");
}

/**
 * Register a just-spawned child; call the returned function once it has been
 * reaped (`await child.exited` returned), so a recycled pid is never signalled.
 */
export function trackLiveChild(child: Killable): () => void {
  if (!reaperInstalled) {
    process.on("exit", reapLiveChildren);
    reaperInstalled = true;
  }
  live.add(child);
  return () => live.delete(child);
}
