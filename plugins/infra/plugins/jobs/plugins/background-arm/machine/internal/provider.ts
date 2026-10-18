import { z } from "zod";
import { isMain } from "@plugins/infra/plugins/runtime-identity/core";
import {
  _jobRunStats,
  _jobRuns,
  listRegisteredJobs,
  resolveJobCron,
  type RegisteredJob,
} from "@plugins/infra/plugins/jobs/server";
import {
  cronRanges,
  nextScheduledRun,
  readJobRunStats,
  readRecentJobRuns,
  runningJobStarts,
  type JobRunRecord,
  type JobRunStats,
} from "@plugins/infra/plugins/jobs/machine";
import type {
  BackgroundEntryDraft,
  BackgroundFact,
  BackgroundRun,
  BackgroundTrigger,
} from "@plugins/infra/plugins/background/plugins/catalog/core";
import { defineBackgroundKind } from "@plugins/infra/plugins/background/plugins/catalog/server";
import { cronWords } from "./cron-words";

// Section names. The groups are the arm's own vocabulary — the catalog imposes
// none — chosen by what a person asks first: "when does it run?".
const GROUP = {
  scheduled: "Scheduled",
  event: "On event",
  onDemand: "On demand",
  cleanup: "Cleanup",
} as const;

/** Every registered job as a catalog entry, with its latest run here. */
export async function listJobEntries(
  now: Date = new Date(),
): Promise<BackgroundEntryDraft[]> {
  const stats = new Map(
    (await readJobRunStats()).map((s) => [s.jobName, s] as const),
  );
  const running = runningJobStarts();
  const main = isMain();
  const entries = listRegisteredJobs().map((job) =>
    jobEntry(job, {
      stats: stats.get(job.name),
      runningSince: running.get(job.name),
      main,
      now,
    }),
  );
  // The catalog keeps groups in the order a provider first lists them.
  return entries.sort(
    (a, b) => GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group),
  );
}

const GROUP_ORDER: readonly string[] = [
  GROUP.scheduled,
  GROUP.event,
  GROUP.onDemand,
  GROUP.cleanup,
];

function jobEntry(
  job: RegisteredJob,
  ctx: {
    stats: JobRunStats | undefined;
    runningSince: Date | undefined;
    main: boolean;
    now: Date;
  },
): BackgroundEntryDraft {
  const scheduled = job.schedule !== undefined;
  const scope =
    job.schedule !== undefined && job.schedule.perWorktree !== true
      ? "main"
      : "every-worktree";
  const runsHere = scope === "main" ? ctx.main : true;
  return {
    name: job.name,
    description: job.description,
    group: groupOf(job),
    trigger: triggerOf(job, ctx.now),
    scope,
    runsHere,
    declaredIn: job.declaredIn,
    lastRun: lastRunOf(ctx.stats, ctx.runningSince),
    history:
      ctx.stats === undefined
        ? { runs: 0, failures: 0, lastSuccessAt: null }
        : {
            runs: ctx.stats.runs,
            failures: ctx.stats.failures,
            lastSuccessAt: ctx.stats.lastSuccessAt?.toISOString() ?? null,
          },
    // Only a scheduled job is guaranteed to start from `{}` (its cron tick
    // does), and only where it would run anyway — a main-only job started by
    // hand in a worktree would repeat main's work against shared state.
    canRunNow: scheduled && runsHere && resolveJobCron(job) !== null,
    internal: job.internal,
    facts: factsOf(job),
  };
}

function groupOf(job: RegisteredJob): string {
  if (job.factory === "defineRetention") return GROUP.cleanup;
  if (job.schedule !== undefined) return GROUP.scheduled;
  if (acceptsEvents(job)) return GROUP.event;
  return GROUP.onDemand;
}

// A job whose event schema is `z.never()` declared it ignores events; any other
// schema means the events dispatcher can deliver to it. Which events is the
// events plugin's knowledge (its BackgroundTriggerSource fills `names` in the catalog), so it starts empty here.
function acceptsEvents(job: RegisteredJob): boolean {
  return !(job.eventSchema instanceof z.ZodNever);
}

function triggerOf(job: RegisteredJob, now: Date): BackgroundTrigger {
  if (job.schedule === undefined) {
    return acceptsEvents(job)
      ? { kind: "event", names: [] }
      : { kind: "on-demand" };
  }
  const expr = resolveJobCron(job);
  if (expr === null) {
    const declared =
      typeof job.schedule.cron === "string" ? job.schedule.cron : "";
    return {
      kind: "cron",
      expr: declared,
      words: "Disabled",
      nextAt: null,
      disabled: true,
    };
  }
  const next = nextScheduledRun(job.name, now);
  return {
    kind: "cron",
    expr,
    words: cronWords(cronRanges(expr), expr),
    nextAt:
      next.installed && next.next !== null ? next.next.toISOString() : null,
    disabled: false,
  };
}

function lastRunOf(
  stats: JobRunStats | undefined,
  runningSince: Date | undefined,
): BackgroundRun | null {
  if (runningSince !== undefined) {
    return {
      startedAt: runningSince.toISOString(),
      finishedAt: null,
      outcome: "running",
      durationMs: null,
      error: null,
    };
  }
  if (stats === undefined) return null;
  return {
    startedAt: stats.lastStartedAt.toISOString(),
    finishedAt: stats.lastFinishedAt.toISOString(),
    outcome: stats.lastOutcome,
    durationMs: stats.lastDurationMs,
    error: stats.lastError,
  };
}

function factsOf(job: RegisteredJob): BackgroundFact[] {
  const facts: BackgroundFact[] = [
    { label: "Duration class", value: job.hold },
    { label: "Attempts", value: String(job.maxAttempts) },
  ];
  if (job.factory === "defineSupervisedJob") {
    facts.push({
      label: "Process",
      value: "Runs in a separate, detached process",
    });
  }
  if (job.serial !== undefined) {
    facts.push({
      label: "Serial",
      value:
        job.serial === true
          ? "Never two at once"
          : `Shares lane "${job.serial.with}"`,
    });
  }
  return facts;
}

function toRun(r: JobRunRecord): BackgroundRun {
  return {
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt.toISOString(),
    outcome: r.outcome,
    durationMs: r.durationMs,
    error: r.error,
  };
}

/** A job's recent runs here, newest first: the one in flight, then the ring. */
export async function jobRecentRuns(name: string): Promise<BackgroundRun[]> {
  const recorded = (await readRecentJobRuns(name)).map(toRun);
  const since = runningJobStarts().get(name);
  if (since === undefined) return recorded;
  return [
    {
      startedAt: since.toISOString(),
      finishedAt: null,
      outcome: "running",
      durationMs: null,
      error: null,
    },
    ...recorded,
  ];
}

/** Enqueue a scheduled job now, with the input its cron tick would carry. */
export async function runJobNow(name: string): Promise<{ ref: string }> {
  const job = listRegisteredJobs().find((j) => j.name === name);
  if (job === undefined) {
    throw new Error(
      `[jobs/background-arm] no job named "${name}" is registered`,
    );
  }
  const { jobId } = await job.enqueue(job.inputSchema.parse({}));
  return { ref: jobId };
}

export const jobsBackgroundKind = defineBackgroundKind({
  kind: "job",
  order: 0,
  label: "Jobs",
  // `list` reads each job's latest run, `recentRuns` its ring.
  tables: [_jobRunStats, _jobRuns],
  list: () => listJobEntries(),
  recentRuns: jobRecentRuns,
  runNow: runJobNow,
});
