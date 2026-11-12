import { afterAll, describe, expect, test } from "bun:test";
import { databaseExists, dropDatabase } from "./databases";
import { runDatabaseDdl } from "./database-ddl";
import { reclaimForkTemp, withForkTempLease } from "./fork-lease";
import { closeAdminPool } from "./pool";
import { forkTempName } from "./temp-name";

// Against the real cluster: the lease is what decides, and only Postgres can
// say whether two sessions' advisory locks conflict.
describe("fork temp lease", () => {
  const temp = forkTempName(`fork-lease-test-${process.pid}`);

  afterAll(async () => {
    await dropDatabase({ unserved: temp, reason: "a test database" });
    await closeAdminPool();
  });

  test("a sweep leaves a leased temp with no connection to it, and reclaims it once the lease is gone", async () => {
    await withForkTempLease(temp, async () => {
      // The window that used to lose the temp: it exists, nothing is connected
      // to it (a fork queued for its slot, or dumping the source).
      await runDatabaseDdl(`test: create ${temp}`, `CREATE DATABASE "${temp}"`);
      expect(await reclaimForkTemp(temp)).toBe("in-use");
      expect(await databaseExists(temp)).toBe(true);
    });
    expect(await reclaimForkTemp(temp)).toBe("dropped");
    expect(await databaseExists(temp)).toBe(false);
  });

  test("a lease already held is refused loudly", async () => {
    await withForkTempLease(temp, async () => {
      expect(withForkTempLease(temp, async () => {})).rejects.toThrow(
        /already held/,
      );
    });
  });
});
