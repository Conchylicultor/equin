// The bound on waiting for someone else. An `awaiting` row files no task — the
// right answer while a partner or upstream is about to publish, and the wrong
// one forever: a third party that never publishes would pin us with nothing
// asking (research/2026-10-16-global-deps-versions-always-move.md). So a
// publish wait goes on for at most AWAIT_MAX_DAYS; past it the row is BLOCKED
// on deciding what to do instead. A cooldown wait is bounded by construction
// (it ends `until`) and never escalates.
//
// Updaters report waits as facts (`AwaitingOn`) and never decide this: the
// detection runs every row through `boundedRows`, and the upgrade task's text
// and title accept only its output, so no updater and no consumer can carry an
// unbounded wait into a task.

import { utcDay } from "./hold";
import type { AwaitingOn, Outdated, OutdatedWaiting } from "./updater";

/** The longest a release may wait on someone else's publish before the wait becomes work. */
export const AWAIT_MAX_DAYS = 30;

const DAY_MS = 86_400_000;

function instant(iso: string, what: string): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`${what} is not an instant: ${iso}`);
  return t;
}

/**
 * What a wait reports on `now`: still `awaiting`, or — a publish wait whose
 * `since` is more than {@link AWAIT_MAX_DAYS} back — `blocked` on choosing
 * what to do about a release that is not coming.
 */
export function awaitingOrBlocked(on: AwaitingOn, now: Date): OutdatedWaiting {
  if (on.kind === "cooldown") return { kind: "awaiting", on };
  const waitedMs =
    now.getTime() - instant(on.since, `the wait on ${on.release}'s since`);
  if (waitedMs <= AWAIT_MAX_DAYS * DAY_MS) return { kind: "awaiting", on };
  const days = Math.floor(waitedMs / DAY_MS);
  return {
    kind: "blocked",
    prerequisite: `waited ${days} days (since ${utcDay(new Date(on.since))}) for ${on.by.join(", ")} to publish ${on.release}: add a hold on it in this updater's holds file (a \`reason\`, the upstream \`issue\` URL and a \`reviewBy\`), chase upstream, or replace the dependency`,
  };
}

declare const BOUNDED: unique symbol;

/** Detected rows with every wait bounded on one `now` — the only rows an upgrade task is built from. */
export type BoundedRows = readonly Outdated[] & { readonly [BOUNDED]: true };

/** `rows` with every `awaiting` wait put through {@link awaitingOrBlocked} on `now`. */
export function boundedRows(rows: readonly Outdated[], now: Date): BoundedRows {
  return rows.map((o) =>
    o.waiting?.kind === "awaiting"
      ? { ...o, waiting: awaitingOrBlocked(o.waiting.on, now) }
      : o,
  ) as unknown as BoundedRows;
}
