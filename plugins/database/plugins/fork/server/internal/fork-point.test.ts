// The fork point round trip against the real cluster: `forkDatabase` stamps the
// database it creates, `databaseForkedAt` reads it back, and the stamp sits
// between the rows the fork copied and the rows written after it.
import { afterAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { z } from "zod";
import {
  dropDatabase,
  ensureDatabase,
  forkDatabase,
  openShortLivedClient,
} from "@plugins/database/plugins/admin/server";
import { databaseForkedAt } from "@plugins/database/plugins/fork-point/server";
import { executeOne } from "@plugins/database/plugins/sql-rows/core";
import { mintTestDbName } from "@plugins/database/plugins/db-test-fixture/core/testing";

const source = mintTestDbName("forkpt_src", process.pid, Date.now());
const target = mintTestDbName("forkpt_dst", process.pid, Date.now());
const sourcePool = openShortLivedClient(source);
const targetPool = openShortLivedClient(target);
const sourceDb = drizzle(sourcePool);
const targetDb = drizzle(targetPool);

const nowMs = async (exec: typeof sourceDb): Promise<number> =>
  (
    await executeOne(exec, {
      query: sql.raw(
        `SELECT (extract(epoch FROM clock_timestamp()) * 1000)::float8 AS ms`,
      ),
      row: z.object({ ms: z.number() }),
      label: "fork-point.test now",
    })
  ).ms;

afterAll(async () => {
  await sourcePool.end();
  await targetPool.end();
  await dropDatabase(target);
  await dropDatabase(source);
});

describe("fork point", () => {
  test("a database never forked has none; its fork is stamped between the copy and its own writes", async () => {
    await ensureDatabase(source);
    expect(await databaseForkedAt(sourceDb)).toBeNull();
    const beforeFork = await nowMs(sourceDb);

    const outcome = await forkDatabase(source, target, {
      tables: [],
      schemas: [],
    });
    expect(outcome.kind).toBe("forked");

    const forkedAt = await databaseForkedAt(targetDb);
    expect(forkedAt).not.toBeNull();
    expect(forkedAt!.getTime()).toBeGreaterThan(beforeFork);
    expect(forkedAt!.getTime()).toBeLessThan(await nowMs(targetDb));
    // The source is untouched.
    expect(await databaseForkedAt(sourceDb)).toBeNull();
  });
});
