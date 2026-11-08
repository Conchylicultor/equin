import { REPO_ROOT } from "@plugins/infra/plugins/paths/plugins/repo-root/core";
import { containsCommit } from "@plugins/primitives/plugins/commit-list/server";
import { runTracked } from "@plugins/infra/plugins/runtime-profiler/core";
import {
  reportServerError,
  sinkHandler,
} from "@plugins/framework/plugins/server-core/core";
import { regresses } from "@plugins/reports/core";
import { stampRegression } from "./fix-ledger";
import {
  fixedReportOccurrenceSink,
  type FixedReportOccurrence,
} from "./occurrence-sink";

// Does the code of an occurrence contain a fix? Asked once per (fix,
// occurrence commit) pair: a process's pin does not change, so a storm from
// one backend costs one git read. Bounded by clearing — the pairs in play are
// a handful of fixes times the few commits live at once.
const MEMO_MAX = 512;
const memo = new Map<string, boolean | null>();

async function codeContains(
  fix: string,
  commit: string,
): Promise<boolean | null> {
  const key = `${fix}\0${commit}`;
  const known = memo.get(key);
  if (known !== undefined) return known;
  const answer = await containsCommit(commit, fix, REPO_ROOT);
  // Not a commit of this repository (another clone's outbox entry): the code
  // cannot be placed, which the verdict reads as unknown code.
  const contains = answer === "unplaceable" ? null : answer;
  if (memo.size >= MEMO_MAX) memo.clear();
  memo.set(key, contains);
  return contains;
}

/**
 * Judge one occurrence of a report that has a pending or live fix: when its
 * code contains the fix — or cannot name its commit once the fix is live —
 * the fix did not hold, and its regression is stamped (the first occurrence
 * wins). A git failure is filed as a server error, never read as either
 * verdict.
 */
async function judgeOccurrence(o: FixedReportOccurrence): Promise<void> {
  const contains =
    o.commit === null ? null : await codeContains(o.fixCommit, o.commit);
  if (!regresses({ deployedAt: o.deployed ? o.at : null }, contains)) return;
  await stampRegression(o.reportId, o.fixCommit, o.commit, o.at);
}

/** The engine's judge of {@link fixedReportOccurrenceSink}, in every boot mode. */
export const regressionJudge = sinkHandler(
  fixedReportOccurrenceSink,
  () => (o) => {
    void runTracked("reports:judge-regression", async () => {
      try {
        await judgeOccurrence(o);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        reportServerError({
          message: `[reports] could not judge whether report ${o.reportId} regressed: ${error.message}`,
          stack: error.stack,
          errorType: error.name,
        });
      }
    });
  },
);
