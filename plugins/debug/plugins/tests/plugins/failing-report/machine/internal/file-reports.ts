import { desc, eq, and, inArray, asc } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { recordReportIncident } from "@plugins/reports/plugins/engine/server";
import type { ReportInput } from "@plugins/reports/core";
import { _reports } from "@plugins/reports/server";
import {
  _testCaseFailures,
  _testCheckoutDigests,
  _testFileResults,
  _testRuns,
} from "@plugins/debug/plugins/tests/server";
import {
  TEST_FAILING_KIND,
  TEST_FAILING_MAX_CASES,
  TestFailingPayloadSchema,
  judgeFailingFile,
  testFailingFingerprint,
  testFailingMessage,
  type JudgedResult,
  type JudgedRun,
  type KnownBreak,
  type TestFailingPayload,
  type TestRunRef,
} from "../../core";

// Results already filed by THIS process, as `<opId>:<path>`: a batch whose run
// yields no record leaves the previous verdict in place, and judging it again
// must not count the same failing run twice. Process memory is enough —
// `onEnded` runs once per batch, so only a later batch of the same process can
// see the same newest result again.
const filed = new Set<string>();

const CASE_MESSAGE_MAX = 200;

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
  return line.length > CASE_MESSAGE_MAX
    ? `${line.slice(0, CASE_MESSAGE_MAX - 1)}…`
    : line;
}

const ref = (r: JudgedRun) => ({
  opId: r.opId,
  commit: r.commit,
  at: r.at.toISOString(),
});
const unref = (r: TestRunRef): JudgedRun => ({
  opId: r.opId,
  commit: r.commit,
  at: new Date(r.at),
});

/**
 * The break the file's existing report already established, or null when it
 * has none. Lets a file broken past the results cap (its last pass on main
 * dropped) keep being reported — and be marked Regressed after a fix.
 */
async function knownBreakOf(path: string): Promise<KnownBreak | null> {
  const fingerprint = testFailingFingerprint({ path });
  const [row] = await db
    .select({ data: _reports.data })
    .from(_reports)
    .where(
      and(
        eq(_reports.kind, TEST_FAILING_KIND),
        eq(_reports.fingerprint, fingerprint),
      ),
    )
    .orderBy(desc(_reports.lastSeenAt))
    .limit(1);
  if (row === undefined) return null;
  const d = TestFailingPayloadSchema.parse(row.data);
  return { lastPassed: unref(d.lastPassed), firstFailed: unref(d.firstFailed) };
}

/**
 * Judge the files an idle batch just ran (their verdicts already ingested) and
 * file a `test-failing` report for each that went from passing to failing on
 * main, confirmed (`judgeFailingFile`). One incident per batch: files broken
 * by one push ring one bell. Answers the files that need a confirmation run
 * (one failure of main's after a pass). Main only — a worktree's failing test
 * is its agent's own feedback loop.
 */
export async function fileTestFailingReports(
  paths: readonly string[],
): Promise<{ confirm: string[] }> {
  const confirm: string[] = [];
  if (!isMain() || paths.length === 0) return { confirm };
  const digests = await db
    .select({
      path: _testCheckoutDigests.path,
      pluginId: _testCheckoutDigests.pluginId,
      digest: _testCheckoutDigests.digest,
    })
    .from(_testCheckoutDigests)
    .where(inArray(_testCheckoutDigests.path, [...paths]));
  if (digests.length === 0) return { confirm };
  const rows = await db
    .select({
      path: _testFileResults.path,
      opId: _testFileResults.opId,
      digest: _testFileResults.digest,
      outcome: _testFileResults.outcome,
      finishedAt: _testFileResults.finishedAt,
      repo: _testRuns.repo,
      commit: _testRuns.headSha,
      failedCases: _testFileResults.failedCases,
    })
    .from(_testFileResults)
    .innerJoin(_testRuns, eq(_testRuns.opId, _testFileResults.opId))
    .where(
      inArray(
        _testFileResults.path,
        digests.map((d) => d.path),
      ),
    )
    .orderBy(
      asc(_testFileResults.path),
      desc(_testFileResults.finishedAt),
      desc(_testFileResults.opId),
    );
  const byPath = new Map<string, JudgedResult[]>();
  const failedCasesOf = new Map<string, number>();
  for (const r of rows) {
    failedCasesOf.set(`${r.opId}:${r.path}`, r.failedCases);
    let list = byPath.get(r.path);
    if (!list) byPath.set(r.path, (list = []));
    list.push({
      opId: r.opId,
      digest: r.digest,
      outcome: r.outcome,
      finishedAt: r.finishedAt,
      ownCheckout: r.repo === REPO_ROOT,
      commit: r.commit,
    });
  }

  const inputs: ReportInput[] = [];
  const keys: string[] = [];
  for (const d of digests) {
    const results = byPath.get(d.path) ?? [];
    let verdict = judgeFailingFile(d.digest, results);
    if (verdict.kind === "quiet" && verdict.reason === "never-passed-here")
      verdict = judgeFailingFile(d.digest, results, await knownBreakOf(d.path));
    if (verdict.kind === "confirm") confirm.push(d.path);
    if (verdict.kind !== "report") continue;
    const key = `${verdict.latest.opId}:${d.path}`;
    if (filed.has(key)) continue;
    const failures = await db
      .select({
        caseId: _testCaseFailures.caseId,
        message: _testCaseFailures.message,
      })
      .from(_testCaseFailures)
      .where(
        and(
          eq(_testCaseFailures.opId, verdict.latest.opId),
          eq(_testCaseFailures.path, d.path),
        ),
      )
      .orderBy(asc(_testCaseFailures.caseId));
    const data: TestFailingPayload = {
      path: d.path,
      pluginId: d.pluginId,
      lastPassed: ref(verdict.lastPassed),
      firstFailed: ref(verdict.firstFailed),
      latest: { ...ref(verdict.latest), outcome: verdict.latest.outcome },
      failuresOnCurrentCode: verdict.failuresOnCurrentCode,
      failingCases: failures.slice(0, TEST_FAILING_MAX_CASES).map((f) => ({
        caseId: f.caseId,
        message: firstLine(f.message),
      })),
      // The run's own count: its record may carry fewer case failures.
      failedCaseCount: Math.max(
        failedCasesOf.get(key) ?? failures.length,
        failures.length,
      ),
    };
    inputs.push({
      kind: TEST_FAILING_KIND,
      source: "server-idle-tests",
      message: testFailingMessage(data),
      // The code that failed, not this backend's pin: what a fix's regression
      // is judged on. A run that named no commit says so (null), never the pin.
      commit: verdict.latest.commit,
      occurredAt: verdict.latest.at.getTime(),
      data,
    });
    keys.push(key);
  }
  if (inputs.length > 0) {
    await recordReportIncident(inputs);
    for (const k of keys) filed.add(k);
  }
  return { confirm };
}
