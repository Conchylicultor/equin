/** Fan-out: emit() hands an observation to every current subscriber, and to nobody else. */
export interface ObservationSink<TBody> {
  /** Adds a subscriber; the returned function removes it (idempotent). */
  subscribe(fn: (body: TBody) => void): () => void;
  emit(body: TBody): void;
  /** Whether any subscriber is listening — a producer skips the work of building a body nobody reads. */
  hasSubscribers(): boolean;
}

// A module-level observation channel: a primitive produces measurements (a
// latency sample, a counter tick) that any number of consumers read side by
// side — a debug panel, a histogram, a slow-op collector — without one evicting
// another. The opposite trade to `defineReportSink`:
//
// - MANY subscribers, not one handler: subscribing never replaces anyone.
// - NOTHING held: an observation emitted while nobody listens is dropped. A
//   measurement is only worth something to whoever is watching now; replaying
//   a backlog to a late subscriber would date it wrongly.
// - A THROWING subscriber is isolated, not swallowed: emit() is called on hot
//   paths (a frame being applied), so one consumer's bug must not break the
//   producer or starve the other subscribers — but it must stay loud, so the
//   error is rethrown on a microtask, where it surfaces as an uncaught error.
//
// Subscribers are snapshotted per emit: one that subscribes or unsubscribes
// during a delivery takes effect from the next emit.
export function defineObservationSink<TBody>(): ObservationSink<TBody> {
  const subscribers = new Set<(body: TBody) => void>();
  return {
    subscribe(fn) {
      // A fresh wrapper per subscription, so subscribing the same function
      // twice is two subscriptions and each unsubscribe removes only its own.
      const entry = (body: TBody) => fn(body);
      subscribers.add(entry);
      return () => {
        subscribers.delete(entry);
      };
    },
    emit(body) {
      if (subscribers.size === 0) return;
      for (const fn of [...subscribers]) {
        try {
          fn(body);
        } catch (err) {
          queueMicrotask(() => {
            throw err;
          });
        }
      }
    },
    hasSubscribers() {
      return subscribers.size > 0;
    },
  };
}
