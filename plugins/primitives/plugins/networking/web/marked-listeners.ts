import { runMarked } from "@plugins/primitives/plugins/perfs/plugins/task-marks/web";

/**
 * A module-level listener set whose fan-out names each listener it runs: every
 * call is a marked task (`primitives/perfs/task-marks`), `<bus> <event> →
 * <listener>`, so a tab frozen inside one subscriber's reaction reports which
 * one — LoAF names only the entry point that published (the shared socket's
 * port handler). A listener is named by the `name` it subscribed with, else
 * its function's own name, else its place in the set (`#2`).
 */
export interface MarkedListeners<E> {
  publish(ev: E): void;
  subscribe(fn: (ev: E) => void, name?: string): () => void;
}

interface Entry<E> {
  readonly fn: (ev: E) => void;
  readonly name: string | null;
}

export function markedListeners<E>(
  bus: string,
  eventName: (ev: E) => string,
): MarkedListeners<E> {
  const listeners = new Set<Entry<E>>();
  return {
    publish(ev) {
      let i = 0;
      for (const entry of listeners) {
        const index = i++;
        runMarked(
          "networking",
          () => ({
            what: `${bus} ${eventName(ev)} → ${entry.name ?? (entry.fn.name || `#${index}`)}`,
            detail: "",
          }),
          () => entry.fn(ev),
        );
      }
    },
    subscribe(fn, name) {
      const entry: Entry<E> = { fn, name: name ?? null };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
  };
}
