import {
  CHECK_THREAD_STALL_KIND,
  NO_SAMPLES_OWNER,
  STALL_REPORT_MS,
  TOTAL_REPORT_MS,
  checkThreadStallMessage,
  type CheckThreadStallOwner,
  type CheckThreadStallPayload,
} from "@plugins/reports/plugins/check-thread-stall/core";
import type {
  MergeBaseResult,
  ProcessReport,
} from "@plugins/reports/plugins/outbox/core";
import type { OwnerShare } from "./thread-attribution";
import type { ThreadStall, ThreadSummary } from "./thread-watch";

// A stall used to reach exactly one place a human might see it: the console of
// whoever ran the check. A new check that blocked the thread for seconds went
// unnoticed until some other check's timeout failed. So a stall that misses the
// track's target files a report (Debug → Reports, the bell) through the report
// outbox — a CLI process has no server to record it.

/** The owners a stall report keeps — the same depth as the progress record. */
const REPORT_OWNERS = 3;

/** Where a run's reports go. `openProgressRun` hands the real outbox; a test a fake. */
export interface StallReportSink {
  /** Must never reject — `fileReportFromProcess` is the contract. */
  file(report: ProcessReport): Promise<unknown>;
  /** Must never reject — `mergeBaseWithMain` is the contract. */
  mergeBase(): Promise<MergeBaseResult>;
}

export interface StallReporter {
  /** A stall closed: file it now if it is long enough, so a killed run still reports. */
  stall(stall: ThreadStall): void;
  /** The run finished: file the total if the stalls add up past the target. */
  finish(summary: ThreadSummary): void;
  /** Resolves once every report this run started filing is written (or refused). */
  settled(): Promise<void>;
}

/**
 * The repo files on some owners' example stacks — an outbox entry's
 * `code.paths`, which main's staleness rule diffs. A frame key is
 * `name @ path:line` with `path` already repo-relative for a repo frame
 * (`shortenSource`); a dependency frame (`node_modules/…`) and one outside the
 * checkout (an absolute path) are not code this repo can fix, so they are left
 * out. Native frames carry no path.
 */
export function codePathsOf(owners: readonly OwnerShare[]): string[] {
  const paths = new Set<string>();
  for (const owner of owners) {
    for (const frame of owner.example) {
      const match = / @ (.+):\d+$/.exec(frame);
      const path = match?.[1];
      if (path === undefined) continue;
      if (path.startsWith("/") || path.split("/").includes("node_modules"))
        continue;
      paths.add(path);
    }
  }
  return [...paths].sort();
}

/**
 * The time a stall report is judged on: how long code HELD the thread, not how
 * late the tick fired — a starved thread (runnable, not scheduled: a
 * background-priority check pass on a busy host) is no code's doing, and was
 * most of what this used to file. Without a thread CPU clock there is no split,
 * and the lateness is all there is: erring toward a report, never toward
 * silence on a platform.
 */
function heldOrLateMs(stall: ThreadStall): number {
  return stall.held.measured ? stall.held.heldMs : stall.lateMs;
}

function reportOwner(share: OwnerShare): CheckThreadStallOwner {
  return {
    owner: share.owner,
    samples: share.samples,
    example: share.example,
  };
}

/**
 * Open a run's reporter. Filing is fire-and-forget from the watch's tick —
 * every step is async, so it never holds the thread it is reporting on — and it
 * can never change the verdict: both sink calls return results, never throw.
 *
 * The merge-base is one `git merge-base` per run, taken lazily on the FIRST
 * report: a run that files nothing spawns nothing.
 */
export function openStallReporter(args: {
  worktree: string;
  runId: string;
  transcript: string | null;
  sink: StallReportSink;
}): StallReporter {
  const { sink } = args;
  let mergeBase: Promise<MergeBaseResult> | null = null;
  let warnedNoBase = false;
  const pending: Promise<void>[] = [];

  const file = (
    payload: CheckThreadStallPayload,
    owners: readonly OwnerShare[],
  ): void => {
    pending.push(
      (async () => {
        mergeBase ??= sink.mergeBase();
        const base = await mergeBase;
        if (!base.ok && !warnedNoBase) {
          warnedNoBase = true;
          // Filed anyway, without a code location: main then cannot tell
          // whether it has fixed the stall since, and files it — erring toward
          // a report, never toward silence.
          console.error(
            `[check-thread-stall] no branch point for this checkout (${base.reason}); ` +
              "stall reports are filed without the code location main uses to drop out-of-date ones",
          );
        }
        await sink.file({
          kind: CHECK_THREAD_STALL_KIND,
          message: checkThreadStallMessage(payload),
          data: payload,
          code: base.ok
            ? { mergeBase: base.mergeBase, paths: codePathsOf(owners) }
            : undefined,
        });
      })(),
    );
  };

  const run = {
    worktree: args.worktree,
    runId: args.runId,
    transcript: args.transcript,
  };

  return {
    stall(stall) {
      if (heldOrLateMs(stall) < STALL_REPORT_MS) return;
      const owners = stall.owners.slice(0, REPORT_OWNERS);
      file(
        {
          trigger: "stall",
          ...run,
          lateMs: stall.lateMs,
          offsetMs: stall.offsetMs,
          topOwner: owners[0]?.owner ?? NO_SAMPLES_OWNER,
          running: stall.running,
          bootstrap: stall.bootstrap,
          samples: stall.samples,
          owners: owners.map(reportOwner),
          kinds: stall.kinds,
          cpu: stall.cpu,
          held: stall.held,
        },
        owners,
      );
    },
    finish(summary) {
      if ((summary.held?.heldMs ?? summary.stalledMs) < TOTAL_REPORT_MS) return;
      const owners = summary.stallOwners.slice(0, REPORT_OWNERS);
      file(
        {
          trigger: "total",
          ...run,
          stalledMs: summary.stalledMs,
          stallCount: summary.stallCount,
          longestLateMs: summary.longestLateMs,
          stallOwners: owners.map(reportOwner),
          kinds: summary.kinds,
          cpu: summary.cpu,
          held: summary.held,
        },
        owners,
      );
    },
    async settled() {
      await Promise.all(pending);
    },
  };
}
