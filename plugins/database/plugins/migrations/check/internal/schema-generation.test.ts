/**
 * Real-DB suite for the schema-generation locks (`database/connection`): a
 * deferred contract's wait ends exactly when the last session holding an older
 * generation goes, and is never held back by a session of a generation that
 * knows the group. Here, beside the schema-layer suites, for the same reason
 * they are: the throwaway-DB fixture would close an import cycle from
 * `connection`.
 *
 * Requires the running embedded cluster (`./equin build` first).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import {
  createDbClient,
  createSchemaGenerationLocks,
} from "@plugins/database/plugins/connection/server";

const OLD = 0xaaaaaaaa;
const NEW = 0xbbbbbbbb;
const NEWER = 0xcccccccc;

let t: TestDb;
// Every session a test opens, ended after it.
let sessions: ReturnType<typeof createDbClient>[] = [];

// Another process of generation `g`: a session holding its shared lock, the
// way `holdSchemaGeneration` takes it.
// `present`: it also holds its presence lock, as `hold` takes it (code from
// before presence locks holds none).
async function processOf(
  g: number,
  { present = true }: { present?: boolean } = {},
): Promise<() => Promise<void>> {
  const c = createDbClient({
    name: "schema-generation",
    connectionString: t.connectionString,
  });
  sessions.push(c);
  await c.connect();
  await c.query("SELECT pg_advisory_lock_shared(1835103860, $1)", [g | 0]);
  if (present) {
    await c.query("SELECT pg_advisory_lock(1835103861, pg_backend_pid())");
  }
  return async () => {
    sessions = sessions.filter((s) => s !== c);
    await c.end();
  };
}

beforeEach(async () => {
  t = await createTestDb({ prefix: "schema_gen_test" });
});

afterEach(async () => {
  for (const c of sessions) await c.end();
  sessions = [];
  await t.drop();
});

test("the wait ends when the last older-generation session goes, not before", async () => {
  const exitOld = await processOf(OLD);
  const exitOldChild = await processOf(OLD);
  // A newer deploy's process knows the group: it never holds the wait back.
  await processOf(NEWER);

  const locks = createSchemaGenerationLocks({
    connectionString: () => t.connectionString,
    log: () => {},
  });
  await locks.hold(NEW);
  let done = false;
  const waiting = locks.awaitGenerationsGone([NEW, NEWER]).then((release) => {
    done = true;
    return release;
  });

  await Bun.sleep(300);
  expect(done).toBe(false);
  await exitOld();
  await Bun.sleep(300);
  expect(done).toBe(false);
  await exitOldChild();
  const release = await waiting;
  expect(done).toBe(true);

  // Old code starting while the contract runs queues behind it, and gets in
  // once the waiter releases.
  let oldStarted = false;
  const starting = processOf(OLD).then((exit) => {
    oldStarted = true;
    return exit;
  });
  await Bun.sleep(300);
  expect(oldStarted).toBe(false);
  await release();
  await starting;
  expect(oldStarted).toBe(true);
});

test("nothing older connected: the wait resolves at once", async () => {
  await processOf(NEWER);
  const locks = createSchemaGenerationLocks({
    connectionString: () => t.connectionString,
    log: () => {},
  });
  await locks.hold(NEW);
  const release = await locks.awaitGenerationsGone([NEW, NEWER]);
  await release();
});

test("holding twice is a bug, refused", async () => {
  const locks = createSchemaGenerationLocks({
    connectionString: () => t.connectionString,
    log: () => {},
  });
  await locks.hold(NEW);
  let error: unknown;
  try {
    await locks.hold(NEWER);
  } catch (e) {
    error = e;
  }
  expect(String(error)).toContain("called twice");
});

test("awaitOlderProcessesGone ends when the last process booted earlier goes, whatever its generation", async () => {
  // Same generation as the waiter: an abandoned deploy's previous backend
  // runs the same migrations, and is still older code.
  const exitOld = await processOf(NEW);
  const exitOlder = await processOf(OLD);
  const locks = createSchemaGenerationLocks({
    connectionString: () => t.connectionString,
    log: () => {},
  });
  await locks.hold(NEW);
  // Booted after the waiter: never waited on.
  await processOf(NEWER);
  let done = false;
  const waiting = locks.awaitOlderProcessesGone().then(() => {
    done = true;
  });

  await Bun.sleep(300);
  expect(done).toBe(false);
  await exitOld();
  await Bun.sleep(300);
  expect(done).toBe(false);
  await exitOlder();
  await waiting;
  expect(done).toBe(true);
});

test("awaitOlderProcessesGone: nothing older connected resolves at once", async () => {
  const locks = createSchemaGenerationLocks({
    connectionString: () => t.connectionString,
    log: () => {},
  });
  await locks.hold(NEW);
  await processOf(NEW);
  await locks.awaitOlderProcessesGone();
});
