import { randomUUID } from "node:crypto";

/**
 * The plugin tree's change signal: one monotonic generation, a token naming it,
 * and the listeners told when it moves.
 *
 * The token carries a per-process boot id beside the counter because it is an
 * ETag (`revalidate`): a counter alone restarts at 0 with every process, so a
 * client holding a tree from the previous boot would match generation 0 of the
 * next one while the tree on disk moved in between. With the boot id no token
 * minted by one process can equal a token minted by another.
 */
export interface TreeChangeSignal {
  /** The tree may have changed: move the generation, then tell every listener. */
  bump(): void;
  /** `<boot>:<generation>` — equal tokens mean no change was seen in between. */
  token(): string;
  /** Hear every `bump`. Returns the unsubscribe. */
  on(listener: () => void): () => void;
}

export function createTreeChangeSignal(): TreeChangeSignal {
  const boot = randomUUID();
  let generation = 0;
  const listeners = new Set<() => void>();
  return {
    bump() {
      generation++;
      // Every listener runs even when one throws, and the first failure is
      // rethrown after: one consumer's bug must not starve the others of the
      // change, and must not be swallowed either.
      let failure: { error: unknown } | null = null;
      for (const listener of [...listeners]) {
        try {
          listener();
        } catch (error) {
          failure ??= { error };
        }
      }
      if (failure !== null) throw failure.error;
    },
    token: () => `${boot}:${generation}`,
    on(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
