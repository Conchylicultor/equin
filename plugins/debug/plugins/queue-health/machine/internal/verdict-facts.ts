import type { QueueActivity } from "@plugins/infra/plugins/jobs/machine";

// The verdict's two database reads, held between loads and re-run only once
// queue activity says they may have moved (`QueueActivity`).
//
// Most activity cannot move them: a successful finish deletes a row that was
// locked, so it changes no waiting row and no death — only the slot ledger,
// which the loader reads from memory every time. So a verdict load after one
// re-reads nothing from the database, and the one after a pickup re-reads the
// per-class aggregate alone; deaths are read again only when a run failed (or a
// mutation such as GC or retry touched the dead set).
//
// Held only while someone tracks the changes (`track`, for as long as the
// verdict is subscribed). Untracked, nothing would ever invalidate a held
// value, so none is kept and every read goes to the database.

/** One held read. */
export interface HeldRead<T> {
  /** The held answer when nothing has moved it since; otherwise the query. */
  read(): Promise<T>;
  /** Run the query now, and hold its answer — what a reader that needs it
   * fresh anyway (the full pulse) does, so the verdict can reuse it. */
  refresh(): Promise<T>;
}

interface Slot<T> {
  /** Bumped by every change that may have moved the answer. */
  gen: number;
  held: { value: T; gen: number } | undefined;
}

function heldRead<T>(
  slot: Slot<T>,
  query: () => Promise<T>,
  tracked: () => boolean,
): HeldRead<T> {
  const refresh = async (): Promise<T> => {
    const gen = slot.gen;
    const value = await query();
    // Stamped with the generation the query STARTED in: a change announced
    // while it ran may be missing from its answer, and leaves it stale.
    if (tracked() && (slot.held === undefined || gen >= slot.held.gen)) {
      slot.held = { value, gen };
    }
    return value;
  };
  return {
    read: () =>
      slot.held !== undefined && slot.held.gen === slot.gen
        ? Promise.resolve(slot.held.value)
        : refresh(),
    refresh,
  };
}

export interface VerdictFacts<C, D> {
  /** `queryQueuePulse`: waiting, oldest waiting and next-due per class. */
  classes: HeldRead<C>;
  /** `queryRecentDeadJobs` over the pulse's window. */
  dead: HeldRead<D>;
  /** Keep the held reads current until the returned release is called.
   * Refcounted: the last release forgets every held answer. */
  track(): () => void;
  /** Something no event announces may have moved them: the change timer
   * fired (a scheduled row becoming due is not an event). */
  invalidateAll(): void;
}

/** Generic over the answers, so it is testable without a database. */
export function createVerdictFacts<C, D>(queries: {
  classes: () => Promise<C>;
  dead: () => Promise<D>;
  onActivity: (listener: (activity: QueueActivity) => void) => () => void;
}): VerdictFacts<C, D> {
  const classSlot: Slot<C> = { gen: 0, held: undefined };
  const deadSlot: Slot<D> = { gen: 0, held: undefined };
  let trackers = 0;
  let stopActivity: (() => void) | undefined;
  const tracked = () => trackers > 0;

  return {
    classes: heldRead(classSlot, queries.classes, tracked),
    dead: heldRead(deadSlot, queries.dead, tracked),
    track() {
      if (trackers++ === 0) {
        // A query that started untracked saw changes nobody counted: make its
        // answer too old to hold.
        classSlot.gen++;
        deadSlot.gen++;
        stopActivity = queries.onActivity((activity) => {
          if (activity.unheldRows) classSlot.gen++;
          if (activity.deaths) deadSlot.gen++;
        });
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        if (--trackers > 0) return;
        stopActivity?.();
        stopActivity = undefined;
        classSlot.held = undefined;
        deadSlot.held = undefined;
      };
    },
    invalidateAll() {
      classSlot.gen++;
      deadSlot.gen++;
    },
  };
}
