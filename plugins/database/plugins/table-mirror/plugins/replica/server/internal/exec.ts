import type { NodePgDatabase } from "drizzle-orm/node-postgres";

/** A transaction handle, as `db.transaction`'s callback receives it. */
export type ReplicaTx = Parameters<
  Parameters<NodePgDatabase["transaction"]>[0]
>[0];

/** Anything a read can run on: the database or an open transaction. */
export type Exec = NodePgDatabase | ReplicaTx;

/** A key the way a key-hash walk answers it. */
export interface KeyHash {
  pk: Record<string, unknown>;
  h: string;
}

/**
 * One canonical text per key, so two spellings of one key compare equal
 * (jsonb hands keys back sorted, a JS object may not be).
 */
export function keyText(pk: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(pk)
      .sort()
      .map((k) => [k, pk[k]]),
  );
}
