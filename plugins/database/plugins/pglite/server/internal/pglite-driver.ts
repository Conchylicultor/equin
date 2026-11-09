import {
  PGlite,
  type QueryOptions,
  type Results,
  type Transaction,
} from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { z } from "zod";
import { executeRows } from "@plugins/database/plugins/sql-rows/core";
import { sql } from "drizzle-orm";
import type { DatabaseDriverImpl, Db } from "@plugins/database/server";
import type { HostStorage } from "@plugins/framework/plugins/browser-server/plugins/host-storage/core";

// A channel is spliced into the LISTEN statement as an identifier.
const CHANNEL_RE = /^[a-z_][a-z0-9_]*$/;

/** Where PGlite keeps its data. */
export interface PgliteDriverOptions {
  /**
   * The browser host's storage, read when the database first opens: its
   * `databaseDir` (in memory, or `idb://…`) and `databaseStart` (a snapshot's
   * data directory to load, its clock shifted to now in `ready`, or an
   * initialized cluster to open instead of running initdb), and the
   * storage closes the database with it (flushed before the storage records
   * it booted, closed before it is wiped or handed to another worker) and can
   * dump it (a snapshot being taken). Absent: in memory, owned by nobody (a
   * test).
   */
  storage?: () => HostStorage;
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
 * Move every instant the database holds by `ms`: each timestamp column of
 * each table of the public schema, in one transaction, with triggers off (the
 * rows did not change — the clock they are read against did; a trigger would
 * restamp `updated_at` or log the move as a change). What a snapshot taken
 * earlier needs to read as recent when it is loaded now.
 */
async function shiftClock(pglite: PGlite, ms: number): Promise<void> {
  // Read through drizzle over PGlite, typed as the app's `Db` the way
  // `db()` hands it out, so the row parser reads it.
  const columns = await executeRows(
    drizzle({ client: pglite }) as unknown as Db,
    {
      row: z.object({ table_name: z.string(), column_name: z.string() }),
      query: sql`SELECT c.table_name, c.column_name
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public'
          AND t.table_type = 'BASE TABLE'
          AND c.data_type IN ('timestamp with time zone', 'timestamp without time zone')
        ORDER BY c.table_name, c.ordinal_position`,
      label: "pglite: timestamp columns",
    },
  );
  const byTable = new Map<string, string[]>();
  for (const { table_name, column_name } of columns) {
    let cols = byTable.get(table_name);
    if (cols === undefined) byTable.set(table_name, (cols = []));
    cols.push(column_name);
  }
  const quote = (id: string): string => `"${id.replaceAll('"', '""')}"`;
  await pglite.transaction(async (tx) => {
    await tx.exec("SET LOCAL session_replication_role = replica");
    for (const [table, cols] of byTable) {
      await tx.exec(
        // sql-writes:hand-written — clock shift over every timestamp column the catalog lists
        `UPDATE ${quote(table)} SET ${cols
          .map(
            (c) => `${quote(c)} = ${quote(c)} + interval '${ms} milliseconds'`,
          )
          .join(", ")}`,
      );
    }
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
  /** The clock shift a snapshot loaded at open still owes, done once in `ready`. */
  let shifting: Promise<void> | null = null;
  let owedShiftMs = 0;
  const open = (): PGlite => {
    const storage = options.storage?.();
    if (storage === undefined) return new PGlite();
    const start = storage.databaseStart;
    const dir = storage.databaseDir;
    // Writes reach IndexedDB after the query, not before it answers: the
    // storage flushes before it records anything as durable. A loaded data
    // dir (a snapshot, or an initialized cluster) spares PGlite its initdb.
    const load =
      start.from === "stored-or-empty" ? {} : { loadDataDir: start.dataDir };
    // In memory, the options are the only argument: `new PGlite(undefined,
    // options)` reads the `undefined` as its options and drops the second.
    const pglite =
      dir === undefined
        ? new PGlite(load)
        : new PGlite(dir, { relaxedDurability: true, ...load });
    if (start.from === "snapshot") owedShiftMs = start.shiftMs;
    // `PGlite.syncToFs()` returns at once under relaxed durability (its sync
    // runs behind the query lock, unawaited), so a flush syncs the filesystem
    // itself: Emscripten's syncfs, awaited, whatever the flag. In memory there
    // is nothing to flush.
    const flush = async (): Promise<void> => {
      await pglite.waitReady;
      if (dir === undefined) return;
      if (pglite.fs === undefined) {
        throw new Error(
          "[pglite] a persistent database has no filesystem to flush",
        );
      }
      await pglite.fs.syncToFs(false);
    };
    storage.adopt({
      flush,
      async close() {
        await flush();
        await pglite.close();
      },
      async dump() {
        await pglite.waitReady;
        return pglite.dumpDataDir("gzip");
      },
    });
    return pglite;
  };
  const pg = (): PGlite => (client ??= open());
  return {
    db() {
      db ??= drizzle({ client: scriptQueries(pg()) }) as unknown as Db;
      return db;
    },
    async ready() {
      await pg().waitReady;
      // A snapshot's instants move to now before anything reads them.
      if (owedShiftMs !== 0) shifting ??= shiftClock(pg(), owedShiftMs);
      await shifting;
    },
    // One connection, nothing else holding locks: boot DDL needs no wider
    // bound than any other query.
    bootDdl: (fn) => fn(),
    // One process, nothing else connected: no older code can be holding a
    // session, so there is nothing to hold and nothing to wait for.
    holdSchemaGeneration: () => Promise.resolve(),
    awaitGenerationsGone: () => Promise.resolve(() => Promise.resolve()),
    awaitOlderProcessesGone: () => Promise.resolve(),
    // LISTEN on the one in-process connection: every NOTIFY a commit sends
    // reaches the root client's `onNotification` (channel and payload, one
    // queue, so the order holds across channels), filtered to this session's
    // channels. Through the ROOT client — the `scriptQueries` proxy over a
    // transaction has no listen. The session is never lost (there is no
    // socket); `close` stops delivery and issues no UNLISTEN, which would
    // silence another session sharing the connection's channels.
    async listen(channels, handlers) {
      const bad = channels.filter((c) => !CHANNEL_RE.test(c));
      if (channels.length === 0 || bad.length > 0) {
        throw new Error(
          `[pglite] listen: channels must be one or more plain identifiers, got ${JSON.stringify(channels)}`,
        );
      }
      const client = pg();
      const wanted = new Set(channels);
      let open = true;
      const off = client.onNotification((channel, payload) => {
        if (open && wanted.has(channel))
          handlers.notification(channel, payload);
      });
      try {
        // ONE statement, so every channel starts with the same commit.
        await client.exec(channels.map((c) => `LISTEN ${c}`).join("; "));
      } catch (err) {
        off();
        throw err;
      }
      return {
        close() {
          open = false;
          off();
          return Promise.resolve();
        },
      };
    },
  };
}
