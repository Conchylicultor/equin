import { db } from "@plugins/database/server";
import {
  readPersistedSnapshots as readPersistedSnapshotsImpl,
  clearPersistedSnapshots as clearPersistedSnapshotsImpl,
} from "./persist";
import { l2Expectation } from "./expectation";

// Singleton-bound public wrappers for the two barrel-exported consumers
// (`readPersistedSnapshots` used by boot-snapshot, `clearPersistedSnapshots` by
// boot-bench). They keep the public `(keys) => …` signature while the underlying
// `persist.ts` fns are db-parametrized. The `db` singleton import lives HERE (a
// backend-only file, imported solely through the barrel) — never in `persist.ts`
// itself, so a test importing `persist.ts` directly never reaches the
// namespace-bound worktree pool in `@plugins/database/server`. Kept out of
// the barrel `index.ts` because barrel-purity (R3) forbids top-level `const`.
//
// The read applies the usable-row predicate against the RUNNING backend's
// expectation (C23): a key it does not persist right now — a bounded preloaded
// window, an external value — is never served from L2, whatever row a previous
// boot left, and neither is a row another definition or an older writer wrote.
export const readPersistedSnapshots = async (
  keys: string[],
): Promise<Map<string, unknown>> => {
  const rows = await readPersistedSnapshotsImpl(db, keys, l2Expectation());
  return new Map([...rows].map(([key, row]) => [key, row.value]));
};

export const clearPersistedSnapshots = (keys: string[]): Promise<number> =>
  clearPersistedSnapshotsImpl(db, keys);
