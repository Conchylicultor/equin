import type { Db } from "@plugins/database/server";

/** The database, or a transaction on it: what the writers here run on. */
export type DbExec = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Split `items` into chunks of at most `size` (one statement each). */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}
