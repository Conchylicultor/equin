// One underlying subscription per key, however many holders want it.
//
// The shape every "watch X while someone reads it" hub re-implemented: a map
// of key → { listeners, stop }, the first acquire opening the subscription,
// each event fanned out to every listener, the last release stopping it. Here
// once, with the two edges the copies kept getting wrong:
//
// - An ASYNC open (a file watch, a git probe) is shared while it is in flight:
//   a second acquire joins it rather than opening a second subscription, and a
//   failed open rejects every joiner and is forgotten, so the next acquire
//   retries from scratch.
// - A last release that lands while the open is still in flight stops the
//   subscription the moment it opens — nothing is left running unowned.

/** Stops one key's subscription. A returned promise is the stop in flight. */
export type HubStop = () => void | Promise<void>;

/**
 * Open the subscription behind `key`: deliver each event through `emit`, and
 * return how to stop it. A sync return is open at once; a promise is the open
 * in flight, and a rejection fails every holder waiting on it.
 */
export type HubOpen<E> = (
  key: string,
  emit: (event: E) => void,
) => HubStop | Promise<HubStop>;

/** One acquire of a key. */
export interface HubHold {
  /**
   * Settles once the key's subscription is open (already settled for a sync
   * open). Rejects with the open's error when it failed — the hold is then
   * dropped, and its `release` does nothing.
   */
  readonly ready: Promise<void>;
  /** Give the hold back. Idempotent; the key's last release stops it. */
  release(): void;
}

export interface RefcountHub<E> {
  /**
   * Hear `key`'s events until the returned hold is released. Each acquire is
   * its own hold, even with the same listener. A sync open that throws throws
   * here, and nothing is held.
   */
  acquire(key: string, listener: (event: E) => void): HubHold;
  /** Whether `key` has a subscription open, or opening. */
  has(key: string): boolean;
  /** The keys with a subscription open or opening. */
  keys(): string[];
}

interface Holder<E> {
  listener: (event: E) => void;
}

interface Entry<E> {
  holders: Set<Holder<E>>;
  /** Null while an async open is in flight. */
  stop: HubStop | null;
  /** Set once the entry left the map: released for good, or failed to open. */
  closed: boolean;
  ready: Promise<void>;
}

function runStop(stop: HubStop): void {
  const pending = stop();
  // A failing stop is loud (an unhandled rejection), never swallowed.
  if (pending instanceof Promise) void pending;
}

/** A hub over the subscriptions `open` makes, one per key. */
export function createRefcountHub<E>(open: HubOpen<E>): RefcountHub<E> {
  const entries = new Map<string, Entry<E>>();

  function emitTo(entry: Entry<E>, event: E): void {
    if (entry.closed) return;
    // A copy: a listener may release (and so mutate) the set. Every listener
    // hears the event even when one throws; the throw is rethrown after.
    const errors: unknown[] = [];
    for (const holder of [...entry.holders]) {
      try {
        holder.listener(event);
      } catch (err) {
        errors.push(err);
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) {
      throw new AggregateError(errors, "refcount-hub: listeners threw");
    }
  }

  function openEntry(key: string): Entry<E> {
    const entry: Entry<E> = {
      holders: new Set(),
      stop: null,
      closed: false,
      ready: Promise.resolve(),
    };
    entries.set(key, entry);
    let opened: HubStop | Promise<HubStop>;
    try {
      opened = open(key, (event) => emitTo(entry, event));
    } catch (err) {
      entries.delete(key);
      entry.closed = true;
      throw err;
    }
    if (!(opened instanceof Promise)) {
      entry.stop = opened;
      return entry;
    }
    entry.ready = opened.then(
      (stop) => {
        // Every holder left while the open was in flight.
        if (entry.closed) runStop(stop);
        else entry.stop = stop;
      },
      (err: unknown) => {
        if (entries.get(key) === entry) entries.delete(key);
        entry.closed = true;
        entry.holders.clear();
        throw err;
      },
    );
    return entry;
  }

  function close(key: string, entry: Entry<E>): void {
    entries.delete(key);
    entry.closed = true;
    // Still opening: the open's own continuation stops it once it lands.
    if (entry.stop !== null) runStop(entry.stop);
  }

  return {
    acquire(key, listener) {
      const entry = entries.get(key) ?? openEntry(key);
      const holder: Holder<E> = { listener };
      entry.holders.add(holder);
      let released = false;
      return {
        ready: entry.ready,
        release() {
          if (released) return;
          released = true;
          entry.holders.delete(holder);
          if (entry.holders.size > 0 || entries.get(key) !== entry) return;
          close(key, entry);
        },
      };
    },
    has: (key) => entries.has(key),
    keys: () => [...entries.keys()],
  };
}
