/**
 * Where a report stands against its fix, derived from facts — never set by
 * hand (research/2026-11-08-reports-fix-state-and-regressions.md):
 *
 * - `open` — no commit on main names it (`Fixes-report:`);
 * - `pending` — a commit on main names it, and main does not run it yet;
 * - `fixed` — main runs the fix, and nothing fired since from code that has it;
 * - `regressed` — it fired again from code that has the fix (or from code that
 *   could not name its commit, once the fix was live).
 *
 * An occurrence from code WITHOUT the fix (a worktree behind main) is no
 * evidence either way and changes nothing.
 */
export const REPORT_FIX_STATES = [
  "open",
  "pending",
  "fixed",
  "regressed",
] as const;
export type ReportFixState = (typeof REPORT_FIX_STATES)[number];

/** Each state as a reader sees it. */
export const REPORT_FIX_STATE_LABELS = {
  open: "Open",
  pending: "Fix pending",
  fixed: "Fixed",
  regressed: "Regressed",
} as const satisfies Record<ReportFixState, string>;

/**
 * The trailer a fixing commit names its report with. `./equin push
 * --fixes-report <id>` is its one writer; main's ledger reads it back.
 */
export const FIXES_REPORT_TRAILER = "Fixes-report";

/** One fix of a report, as the ledger (`report_fixes`) holds it. */
export interface ReportFixFacts {
  /** The fixing commit (the newest commit of its push naming the report). */
  commit: string;
  /** When the commit reached main. */
  landedAt: Date;
  /** When main first ran code containing it; null while it does not. */
  deployedAt: Date | null;
  /** The first occurrence from code containing it; null while there is none. */
  regressedAt: Date | null;
}

/** A report's derived fix state, and since when it holds. */
export interface ReportFixStanding {
  fixState: ReportFixState;
  fixCommit: string | null;
  fixStateAt: Date | null;
}

/** The standing of a report whose latest fix is `latest` (null: none). */
export function fixStandingOf(
  latest: ReportFixFacts | null,
): ReportFixStanding {
  if (latest === null) {
    return { fixState: "open", fixCommit: null, fixStateAt: null };
  }
  const { commit } = latest;
  if (latest.regressedAt !== null) {
    return {
      fixState: "regressed",
      fixCommit: commit,
      fixStateAt: latest.regressedAt,
    };
  }
  if (latest.deployedAt !== null) {
    return {
      fixState: "fixed",
      fixCommit: commit,
      fixStateAt: latest.deployedAt,
    };
  }
  return {
    fixState: "pending",
    fixCommit: commit,
    fixStateAt: latest.landedAt,
  };
}

/**
 * Whether an occurrence regresses an unregressed fix. `contains` is whether
 * the occurrence's code descends from the fix commit (`null`: the occurrence
 * could not name its commit, or the commit is not one of this repository).
 * Unknown code counts once the fix is live — "cannot tell" never keeps a
 * report quietly fixed — but not before: then the code most likely predates
 * the fix.
 */
export function regresses(
  fix: Pick<ReportFixFacts, "deployedAt">,
  contains: boolean | null,
): boolean {
  if (contains === null) return fix.deployedAt !== null;
  return contains;
}
