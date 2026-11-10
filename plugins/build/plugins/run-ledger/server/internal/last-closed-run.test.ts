/**
 * `lastClosedRunOn` — the convergence decision's "already attempted?" read —
 * on a real Postgres seeded with the real migration chain.
 *
 * Run: `./equin test plugins/build/plugins/run-ledger`
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
import {
  asNamespace,
  MAIN_COMPOSITION_ID,
} from "@plugins/infra/plugins/namespace/core";
import { lastClosedRunOn } from "../../shared/recorder";
import { _buildRuns } from "./tables";
import { buildRunIdKind } from "../../core/internal/id-kind";

const NS = asNamespace("ledger-last-closed-test");
const OTHER = asNamespace("ledger-last-closed-other");

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "build_runs_last_closed_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(sql`delete from "build_runs"`);
});

async function run(r: {
  namespace?: string;
  targets: string[];
  commit: string;
  exitCode: number | null;
  startedAt: Date;
}): Promise<void> {
  await t.db.insert(_buildRuns).values({
    id: buildRunIdKind.mint(),
    trigger: "auto",
    commitHash: r.commit,
    targets: r.targets,
    namespace: r.namespace ?? NS,
    pid: process.pid,
    startedAt: r.startedAt,
    finishedAt: r.exitCode === null ? null : r.startedAt,
    exitCode: r.exitCode,
  });
}

describe("lastClosedRunOn", () => {
  test("an empty ledger is none", async () => {
    expect(
      await lastClosedRunOn(t.db, NS, { only: MAIN_COMPOSITION_ID }),
    ).toEqual({ kind: "none" });
  });

  test("the newest CLOSED run wins; an open one is not an attempt yet", async () => {
    await run({
      targets: [MAIN_COMPOSITION_ID],
      commit: "aaa",
      exitCode: 1,
      startedAt: new Date(1000),
    });
    await run({
      targets: [MAIN_COMPOSITION_ID],
      commit: "bbb",
      exitCode: null,
      startedAt: new Date(2000),
    });
    expect(
      await lastClosedRunOn(t.db, NS, { only: MAIN_COMPOSITION_ID }),
    ).toEqual({ kind: "run", commitHash: "aaa", exitCode: 1 });
  });

  test("only is equality, includes is containment", async () => {
    await run({
      targets: [MAIN_COMPOSITION_ID, "sonata"],
      commit: "ccc",
      exitCode: 0,
      startedAt: new Date(3000),
    });
    expect(
      await lastClosedRunOn(t.db, NS, { only: MAIN_COMPOSITION_ID }),
    ).toEqual({ kind: "none" });
    expect(await lastClosedRunOn(t.db, NS, { includes: "sonata" })).toEqual({
      kind: "run",
      commitHash: "ccc",
      exitCode: 0,
    });
  });

  test("another namespace's rows are not this namespace's attempts", async () => {
    await run({
      namespace: OTHER,
      targets: [MAIN_COMPOSITION_ID],
      commit: "ddd",
      exitCode: 0,
      startedAt: new Date(4000),
    });
    expect(
      await lastClosedRunOn(t.db, NS, { only: MAIN_COMPOSITION_ID }),
    ).toEqual({ kind: "none" });
  });
});
