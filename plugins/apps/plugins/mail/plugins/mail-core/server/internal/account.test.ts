/**
 * THE mail account, against a real Postgres (db-test-fixture) with the real
 * migration chain: `readMailAccount` picks the EARLIEST connected account —
 * `connected_at`, then `id` — whatever order the rows were inserted in, an
 * account that never recorded a connection comes after every one that did, and
 * no account at all is `null`.
 *
 * `readMailAccount` is the one definition both the `mailAccount` live value
 * (the threads list's scope) and `resolveMailAccountId` (every server read
 * path) run, so pinning it pins that they agree.
 *
 * Run: `./equin test plugins/apps/plugins/mail/plugins/mail-core`
 * (requires the running embedded cluster — `./equin build` first).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { readMailAccount } from "./account";
import { _mailAccounts } from "./tables";
import { mailAccountIdKind } from "../../core";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "mail_account_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(sql`DELETE FROM mail_accounts`);
});

async function insertAccount(id: string, connectedAt: Date | null) {
  const now = new Date("2026-09-30T12:00:00Z");
  await t.db.insert(_mailAccounts).values({
    id: mailAccountIdKind.key(id),
    email: `${id}@example.invalid`,
    connectedAt,
    createdAt: now,
    updatedAt: now,
  });
}

const EARLY = new Date("2026-01-01T00:00:00Z");
const LATE = new Date("2026-06-01T00:00:00Z");

describe("readMailAccount", () => {
  test("no account is null", async () => {
    expect(await readMailAccount(t.db)).toBeNull();
  });

  test("the earliest connected wins, not the first inserted nor the smallest id", async () => {
    await insertAccount("a-late", LATE);
    await insertAccount("z-early", EARLY);
    expect(await readMailAccount(t.db)).toEqual({
      id: mailAccountIdKind.key("z-early"),
      email: "z-early@example.invalid",
    });
  });

  test("equal connection times break on id", async () => {
    await insertAccount("m", EARLY);
    await insertAccount("c", EARLY);
    expect<string | undefined>((await readMailAccount(t.db))?.id).toBe("c");
  });

  test("an account with no recorded connection comes after every connected one", async () => {
    await insertAccount("a-unconnected", null);
    await insertAccount("z-connected", LATE);
    expect<string | undefined>((await readMailAccount(t.db))?.id).toBe(
      "z-connected",
    );
  });
});
