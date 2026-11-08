/**
 * Suite for the fix ledger (`fix-ledger.ts`) against a throwaway Postgres
 * seeded with the REAL migration chain: a claim lands (pending), the code
 * containing it goes live (fixed), an occurrence from code containing it
 * regresses it — the report's derived fix state, its notifications restated
 * in place (never moved), and the regression filed as a NEW error row on top.
 * Ancestry is real git, in a throwaway repo.
 *
 * Run: `./equin test plugins/reports/plugins/engine`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { mountProducersForTest } from "@plugins/network/plugins/live/plugins/change-feed/server/testing";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { clearCollectedContributions } from "@plugins/framework/plugins/server-core/core/testing";
import { runGit } from "@plugins/primitives/plugins/commit-list/server";
import { _notifications } from "@plugins/shell/plugins/notifications/server";
import { _reports, ReportKind } from "@plugins/reports/server";
import { reportIdKind, type ReportId } from "@plugins/reports/core";
import { writeReport } from "./record-report";
import { reportsProducer } from "./producer";
import { ringRowBell } from "./bell";
import { _reportFixes } from "./tables";
import {
  recordFixClaims,
  stampFixesContainedIn,
  stampRegression,
} from "./fix-ledger";

const REPORT = reportIdKind.key("report-fix-ledger-test");
// Reports a `Report-fixed-by` claim names after they were already recorded:
// one only from code before the fix, one also from code containing it.
const BEFORE_ONLY = reportIdKind.key("report-fix-ledger-before-only");
const SEEN_AFTER = reportIdKind.key("report-fix-ledger-seen-after");

describe("fix ledger (real DB)", () => {
  let t: TestDb;
  let unmount: () => void;
  let repo: string;
  let fix: string;
  let later: string;
  let before: string;

  const report = async () =>
    (await t.db.select().from(_reports).where(eq(_reports.id, REPORT)))[0];
  const notes = async () =>
    t.db
      .select()
      .from(_notifications)
      .where(sql`${_notifications.metadata} ->> 'reportId' = ${REPORT}`)
      .orderBy(desc(_notifications.createdAt));

  beforeAll(async () => {
    t = await createTestDb({ prefix: "report_fixes_test" });
    await runMigrations(t.db);
    unmount = mountProducersForTest([reportsProducer], { route: () => {} });
    collectContributions([
      {
        id: "test/report-kind",
        contributions: [
          ReportKind({
            kind: "crash",
            schema: z.record(z.string(), z.unknown()),
            fingerprint: () => "fp-fix",
            meta: { tag: "crash", notif: "Crash recorded", variant: "warning" },
            renderTask: () => ({ title: "t", description: "d" }),
          }),
        ],
      },
    ]);
    // before → fix → later: `later` contains the fix, `before` does not.
    repo = await mkdtemp(join(tmpdir(), "report-fixes-"));
    const commit = async (msg: string) => {
      await runGit(
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@t",
          "commit",
          "--allow-empty",
          "-q",
          "-m",
          msg,
        ],
        repo,
      );
      return (await runGit(["rev-parse", "HEAD"], repo)).trim();
    };
    await runGit(["init", "-q"], repo);
    before = await commit("before");
    fix = await commit("fix");
    later = await commit("later");

    const [row] = await writeReport(
      {
        id: REPORT,
        kind: "crash",
        fingerprint: "fp-fix",
        worktree: "wt-test",
        source: "server-crash",
        message: "error watching runs",
        url: null,
        userAgent: null,
        data: {},
        limited: false,
        noise: false,
        staleOrigin: false,
        clientId: null,
        buildId: null,
        commit: before,
        occurredAt: new Date(),
      },
      t.db,
    );
    // The report's bell row before any fix, as recordReport rings it.
    await ringRowBell(row!, t.db);
    await t.db
      .update(_reports)
      .set({ taskId: "task-old-investigation" })
      .where(eq(_reports.id, REPORT));
  });

  afterAll(async () => {
    clearCollectedContributions();
    unmount();
    await t.drop();
    await rm(repo, { recursive: true, force: true });
  });

  test("a landed claim makes it pending, and its notification says so in place", async () => {
    const [first] = await notes();
    const n = await recordFixClaims(
      [{ reportId: REPORT, commit: fix, landedAt: new Date() }],
      repo,
      t.db,
    );
    expect(n).toBe(1);
    expect(await report()).toMatchObject({
      fixState: "pending",
      fixCommit: fix,
    });
    const [note] = await notes();
    expect(note?.id).toBe(first?.id);
    expect(note?.createdAt).toEqual(first?.createdAt);
    expect(note?.state?.tone).toBe("pending");
    // A claim seen again records nothing.
    expect(
      await recordFixClaims(
        [{ reportId: REPORT, commit: fix, landedAt: new Date() }],
        repo,
        t.db,
      ),
    ).toBe(0);
  });

  test("it is fixed only once both carriers contain it", async () => {
    await stampFixesContainedIn(
      { server: later, web: before, repoRoot: repo },
      t.db,
    );
    expect((await report())?.fixState).toBe("pending");
    await stampFixesContainedIn(
      { server: later, web: later, repoRoot: repo },
      t.db,
    );
    expect(await report()).toMatchObject({ fixState: "fixed", fixCommit: fix });
    const all = await notes();
    expect(all).toHaveLength(1);
    expect(all[0]?.state?.tone).toBe("resolved");
  });

  test("a regression files a new error row on top, restates the old one, and unlinks the task", async () => {
    const [old] = await notes();
    await stampRegression(REPORT, fix, later, new Date(), t.db);
    expect(await report()).toMatchObject({
      fixState: "regressed",
      fixCommit: fix,
      taskId: null,
    });
    const all = await notes();
    expect(all).toHaveLength(2);
    const [top, earlier] = all;
    expect(top?.variant).toBe("error");
    expect(top?.state?.tone).toBe("recurred");
    expect(earlier?.id).toBe(old?.id);
    expect(earlier?.createdAt).toEqual(old?.createdAt);
    expect(earlier?.state?.tone).toBe("recurred");
    // The first regression wins: a second one changes nothing.
    await stampRegression(REPORT, fix, later, new Date(), t.db);
    expect(await notes()).toHaveLength(2);
  });

  describe("a claim on an earlier commit (Report-fixed-by)", () => {
    const occur = async (id: ReportId, commit: string, at: Date) =>
      writeReport(
        {
          id,
          kind: "crash",
          fingerprint: `fp-${id}`,
          worktree: "wt-test",
          source: "server-crash",
          message: "error watching runs",
          url: null,
          userAgent: null,
          data: {},
          limited: false,
          noise: false,
          staleOrigin: false,
          clientId: null,
          buildId: null,
          commit,
          occurredAt: at,
        },
        t.db,
      );
    const stateOf = async (id: ReportId) =>
      (await t.db.select().from(_reports).where(eq(_reports.id, id)))[0];
    const fixRow = async (id: ReportId) =>
      (
        await t.db
          .select()
          .from(_reportFixes)
          .where(eq(_reportFixes.reportId, id))
      )[0];

    test("seen only from code before the fix, it is pending like any claim", async () => {
      await occur(BEFORE_ONLY, before, new Date("2026-11-05T10:00:00Z"));
      await recordFixClaims(
        [
          {
            reportId: BEFORE_ONLY,
            commit: fix,
            landedAt: new Date(),
            claimedBy: later,
          },
        ],
        repo,
        t.db,
      );
      expect(await stateOf(BEFORE_ONLY)).toMatchObject({
        fixState: "pending",
        fixCommit: fix,
      });
    });

    test("already seen from code containing the fix, it is regressed at once — the earliest such occurrence", async () => {
      const first = new Date("2026-11-05T10:00:00Z");
      await occur(SEEN_AFTER, before, new Date("2026-11-04T10:00:00Z"));
      await occur(SEEN_AFTER, later, first);
      await occur(SEEN_AFTER, later, new Date("2026-11-06T10:00:00Z"));
      await recordFixClaims(
        [
          {
            reportId: SEEN_AFTER,
            commit: fix,
            landedAt: new Date(),
            claimedBy: later,
          },
        ],
        repo,
        t.db,
      );
      expect(await stateOf(SEEN_AFTER)).toMatchObject({
        fixState: "regressed",
        fixCommit: fix,
      });
      expect(await fixRow(SEEN_AFTER)).toMatchObject({
        regressedAt: first,
        regressedCommit: later,
      });
    });
  });
});
