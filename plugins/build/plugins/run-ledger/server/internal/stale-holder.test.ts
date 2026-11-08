/**
 * The claim-time settle of a dead `build_runs_inflight_uniq` holder, on a real
 * Postgres (db-test-fixture, seeded with the REAL migration chain) and real
 * exit markers under a temp data root.
 *
 * Drives `claimInflightRun` — the db-parametrized body of the CLI recorder's
 * `insertRun` — so each scenario asserts the whole path: the insert losing to
 * the index, the holder being settled (or not), and the one retry.
 *
 * Run: `./equin test plugins/build/plugins/run-ledger`
 * (requires the running embedded cluster — `./equin build` first).
 */

import {
  readEnv,
  setEnv,
  unsetEnv,
} from "@plugins/infra/plugins/launcher/plugins/env-names/core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { HARD_KILL_EXIT_CODE } from "@plugins/infra/plugins/jobs/plugins/supervised-job/core";
import {
  worktreeArtifacts,
  worktreeDataDir,
} from "@plugins/infra/plugins/paths/core";
import {
  asNamespace,
  MAIN_COMPOSITION_ID,
} from "@plugins/infra/plugins/namespace/core";
import {
  claimInflightRun,
  closeRunOn,
  type InsertRunRow,
} from "../../shared/recorder";
import { readBuildTerminal } from "../../shared/stale-holder";
import { _buildRuns } from "./tables";
import { buildRunIdKind } from "../../core/internal/id-kind";
import { BUILD_RUN_KIND_ID } from "../../core/internal/supervised-kind";

const NS = asNamespace("ledger-settle-test");

let t: TestDb;
let dataRoot: string;
const priorDataRoot = readEnv("DIR");

beforeAll(async () => {
  // DB first: the admin connection config is resolved (and cached) before the
  // data root is pointed at the temp dir below.
  t = await createTestDb({ prefix: "build_runs_settle_test" });
  await runMigrations(t.db);
  dataRoot = mkdtempSync(join(tmpdir(), "sg-ledger-settle-"));
  // `worktreesDir()` reads this on every call, so the run-marker paths resolve
  // under the temp root for the rest of the suite.
  setEnv("DIR", dataRoot);
});

afterAll(async () => {
  if (priorDataRoot === undefined) unsetEnv("DIR");
  else setEnv("DIR", priorDataRoot);
  rmSync(dataRoot, { recursive: true, force: true });
  await t.drop();
});

beforeEach(() => {
  mkdirSync(worktreeDataDir(NS), { recursive: true });
});

afterEach(async () => {
  await t.db.execute(sql`delete from "build_runs"`);
  rmSync(worktreeDataDir(NS), { recursive: true, force: true });
});

let seq = 0;
function row(pid: number): InsertRunRow {
  return {
    id: `settle-test-${process.pid}-${seq++}`,
    targets: [MAIN_COMPOSITION_ID],
    trigger: "manual",
    commitHash: null,
    pid,
  };
}

/** The run's exit marker, as the shim (or the attached relay) writes it. */
function writeMarker(buildId: string, body: string, mtime?: Date): void {
  mkdirSync(worktreeArtifacts.runsDir(NS), { recursive: true });
  const path = worktreeArtifacts.runTerminal(NS, BUILD_RUN_KIND_ID, buildId);
  writeFileSync(path, body);
  if (mtime) utimesSync(path, mtime, mtime);
}

async function readRow(id: string) {
  const [r] = await t.db
    .select({
      finishedAt: _buildRuns.finishedAt,
      exitCode: _buildRuns.exitCode,
    })
    .from(_buildRuns)
    .where(eq(_buildRuns.id, buildRunIdKind.key(id)));
  if (r === undefined) throw new Error(`no build_runs row ${id}`);
  return r;
}

async function deadPid(): Promise<number> {
  const proc = Bun.spawn(["true"]);
  const pid = proc.pid;
  await proc.exited; // reaped ⇒ ESRCH on the subsequent probe
  return pid;
}

describe("claimInflightRun settles a dead holder", () => {
  test("holder with an exit marker ⇒ closed with its exitCode and mtime; claim succeeds", async () => {
    // A live pid on the holder: the record answers before the pid is consulted.
    const holder = row(process.pid);
    expect(await claimInflightRun(t.db, NS, holder)).toBe("claimed");
    const ended = new Date("2026-09-16T14:27:06.000Z");
    writeMarker(holder.id, "1 -\n", ended);

    const next = row(process.pid);
    expect(await claimInflightRun(t.db, NS, next)).toBe("claimed");

    const closed = await readRow(holder.id);
    expect(closed.exitCode).toBe(1);
    expect(closed.finishedAt?.getTime()).toBe(ended.getTime());
    expect((await readRow(next.id)).finishedAt).toBeNull();
  });

  test("no record + dead pid ⇒ closed as a hard kill; claim succeeds", async () => {
    const holder = row(await deadPid());
    expect(await claimInflightRun(t.db, NS, holder)).toBe("claimed");

    const next = row(process.pid);
    expect(await claimInflightRun(t.db, NS, next)).toBe("claimed");

    const closed = await readRow(holder.id);
    expect(closed.exitCode).toBe(HARD_KILL_EXIT_CODE);
    expect(closed.finishedAt).not.toBeNull();
  });

  test("no record + live pid ⇒ lost, holder untouched", async () => {
    const holder = row(process.pid);
    expect(await claimInflightRun(t.db, NS, holder)).toBe("claimed");

    const next = row(process.pid);
    expect(await claimInflightRun(t.db, NS, next)).toBe("lost");

    const kept = await readRow(holder.id);
    expect(kept.finishedAt).toBeNull();
    expect(kept.exitCode).toBeNull();
    const [count] = await t.db
      .select({ n: sql<number>`count(*)::int` })
      .from(_buildRuns)
      .where(eq(_buildRuns.id, buildRunIdKind.key(next.id)));
    expect(count?.n).toBe(0);
  });

  test("malformed record ⇒ throws, holder untouched", async () => {
    const holder = row(await deadPid());
    expect(await claimInflightRun(t.db, NS, holder)).toBe("claimed");
    writeMarker(holder.id, "not a marker");

    expect(claimInflightRun(t.db, NS, row(process.pid))).rejects.toThrow(
      /malformed exit marker/,
    );
    expect((await readRow(holder.id)).finishedAt).toBeNull();
  });

  test("a primary-key collision is not read as in-flight", async () => {
    const holder = row(await deadPid());
    expect(await claimInflightRun(t.db, NS, holder)).toBe("claimed");
    await t.db
      .update(_buildRuns)
      .set({ finishedAt: new Date(), exitCode: 0 })
      .where(eq(_buildRuns.id, buildRunIdKind.key(holder.id)));

    expect(claimInflightRun(t.db, NS, holder)).rejects.not.toMatchObject({
      constraint: "build_runs_inflight_uniq",
    });
  });
});

describe("closeRunOn", () => {
  // The success half of the tolerance `missing-ledger.test.ts` pins: on a
  // database that HAS the table, the same call stamps the row rather than
  // absorbing anything. This suite owns the migrated database, so the pair
  // lives across the two files rather than paying for a second migration pass.
  test("stamps finishedAt and exitCode, first-writer-wins", async () => {
    const r = row(process.pid);
    expect(await claimInflightRun(t.db, NS, r)).toBe("claimed");

    await closeRunOn(t.db, r.id, 3);
    const closed = await readRow(r.id);
    expect(closed.exitCode).toBe(3);
    const firstStamp = closed.finishedAt;
    expect(firstStamp).not.toBeNull();

    // A second close finds `finished_at` set and changes nothing.
    await closeRunOn(t.db, r.id, 0);
    const again = await readRow(r.id);
    expect(again.exitCode).toBe(3);
    expect(again.finishedAt?.getTime()).toBe(firstStamp!.getTime());
  });
});

describe("readBuildTerminal", () => {
  test("missing file ⇒ null", async () => {
    expect(await readBuildTerminal(NS, "no-such-build")).toBeNull();
  });

  test("the marker's code and mtime", async () => {
    const ended = new Date("2026-09-16T14:27:06.000Z");
    writeMarker("ended", "143 TERM\n", ended);
    expect(await readBuildTerminal(NS, "ended")).toEqual({
      exitCode: 143,
      finishedAt: ended,
    });
  });

  test("a malformed marker ⇒ throws", () => {
    writeMarker("bad-shape", "{}");
    expect(readBuildTerminal(NS, "bad-shape")).rejects.toThrow(
      /malformed exit marker/,
    );
  });
});
