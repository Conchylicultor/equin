// `isOpenTransaction` decides whether an emit's keyed subscribers need the
// events.dispatch outbox, so it must tell a drizzle transaction from a database
// handle on the real driver — not on a mock of drizzle's class hierarchy.
//
// Run: `./equin test plugins/infra/plugins/events`
// (requires the running embedded cluster — `./equin build` first).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { isOpenTransaction } from "./open-transaction";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "events_open_tx_test" });
});

afterAll(async () => {
  await t.drop();
});

test("a database handle is not a transaction", () => {
  expect(isOpenTransaction(t.db)).toBe(false);
  expect(isOpenTransaction(undefined)).toBe(false);
});

test("a forwarding Proxy over a database is not a transaction", () => {
  // The shape of the app's `db`: a Proxy over `{}` forwarding to the driver.
  const proxied = new Proxy({} as typeof t.db, {
    get: (_target, prop) => Reflect.get(t.db, prop) as unknown,
  });
  expect(isOpenTransaction(proxied)).toBe(false);
});

test("a transaction and a savepoint inside it are transactions", async () => {
  await t.db.transaction(async (tx) => {
    expect(isOpenTransaction(tx)).toBe(true);
    await tx.transaction(async (sp) => {
      await sp.execute(sql`select 1`);
      expect(isOpenTransaction(sp)).toBe(true);
    });
  });
});
