import {
  PGlite,
  type QueryOptions,
  type Results,
  type Transaction,
} from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { DatabaseDriverImpl, Db } from "@plugins/database/server";

/** Where PGlite keeps its data: `undefined` is in memory (lost with the
 *  process), else a PGlite `dataDir` (`idb://…` in a browser). */
export interface PgliteDriverOptions {
  dataDir?: string;
}

/**
 * The one difference between node-postgres and PGlite the app's SQL can hit:
 * node-postgres sends a PARAMETERLESS query over the simple protocol, which
 * accepts a script of several statements (a migration file, a view rebuild);
 * PGlite's `query` always uses the extended protocol, one statement only. So a
 * parameterless query that is not a builder select (those ask for array rows)
 * goes through PGlite's simple-protocol `exec`, and answers with its LAST
 * statement's result — the one result a single statement has.
 *
 * A failed attempt cannot be retried the other way instead: inside a
 * transaction any error aborts it, so the choice is made up front.
 */
function scriptQueries<C extends PGlite | Transaction>(client: C): C {
  // A passthrough: what the caller does with the rows (drizzle's mapping, a
  // raw-SQL caller's `executeRows` parse) is unchanged.
  async function query(
    text: string,
    params?: unknown[],
    options?: QueryOptions,
  ): Promise<Results> {
    if (
      (params === undefined || params.length === 0) &&
      options?.rowMode !== "array"
    ) {
      const last = (await client.exec(text, options)).at(-1);
      if (last === undefined) {
        throw new Error(
          `[pglite] exec returned no result for: ${text.slice(0, 120)}`,
        );
      }
      return last;
    }
    return client.query(text, params, options);
  }
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === "query") return query;
      if (prop === "transaction" && target instanceof PGlite) {
        return <T>(callback: (tx: Transaction) => Promise<T>) =>
          target.transaction((tx) => callback(scriptQueries(tx)));
      }
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/**
 * A `DatabaseDriver` over PGlite — Postgres compiled to WASM, in this process.
 *
 * The drizzle instance is PGlite's own (`drizzle-orm/pglite`); it shares the
 * query builder every portable query is written against, and is handed
 * through the app's `Db` type (see that type for the result-shape difference
 * still to widen).
 */
export function createPgliteDriver(
  options: PgliteDriverOptions = {},
): DatabaseDriverImpl {
  let client: PGlite | null = null;
  let db: Db | null = null;
  const pg = (): PGlite => (client ??= new PGlite(options.dataDir));
  return {
    db() {
      db ??= drizzle({ client: scriptQueries(pg()) }) as unknown as Db;
      return db;
    },
    async ready() {
      await pg().waitReady;
    },
    // One connection, nothing else holding locks: boot DDL needs no wider
    // bound than any other query.
    bootDdl: (fn) => fn(),
  };
}
