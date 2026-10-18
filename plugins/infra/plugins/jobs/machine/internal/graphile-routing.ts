import type { TaskSpec } from "graphile-worker";
import { priorityFor, taskFor, type HoldClass } from "../../core/hold";
import type { SerialSpec } from "../../server/internal/registry";

// --- The one derivation of a graphile queue name ------------------------------
//
// A serialized job that is enqueued WITHOUT its queue name escapes its own
// serialization — the row lands with `job_queue_id IS NULL`, graphile fetches it
// regardless of who else is running, and the guarantee silently evaporates for
// that one path. There are five places a job row is inserted (`enqueue`'s
// two transports, `jobs.resume`'s target re-enqueue, a suspend's
// `scheduleResume`, and `worker.ts`'s cron items), so "remember to pass the
// queue name" is five chances to be wrong and no way to notice.
//
// Hence: the queue name is derived from the REGISTERED JOB and is never a caller
// argument. `queueNameFor` is the single derivation; `graphileSpecFor` is the
// single assembly of a graphile insertion around it, and the raw-SQL enqueue
// path reads its columns off that same spec rather than composing its own. The
// `jobs:no-raw-addjob` check (`../../check/index.ts`) bans `utils.addJob(` and
// `graphile_worker.add_job` everywhere but `graphile-queue.ts` (the one
// insertion, under `JobQueue.enqueue`), so a sixth insertion site cannot be
// written without going through here.
//
// The job's TASK IDENTIFIER and PRIORITY join the queue name under exactly the
// same argument, and for exactly the same reason. Which graphile task a row sits
// on is what decides which runners can ever fetch it (`worker.ts`'s ladder), and
// the priority is what makes a runner prefer the longest class it may serve. A
// row inserted on the wrong task is not slow — it is unreachable by the runners
// that were supposed to reserve capacity for it, or reachable by ones that were
// not. Both are properties of the REGISTERED JOB (its `hold`), never caller
// arguments, so they flow through this one assembly with the queue name.

/** `sg:` namespaces our queue names inside graphile's global queue-name space,
 * so they are recognizable in `_private_job_queues` and cannot collide with a
 * name some future library picks. */
const QUEUE_PREFIX = "sg:";

/**
 * The graphile `queue_name` for a registered job, or `undefined` when the job
 * declared no {@link SerialSpec} (the overwhelming majority — an unnamed queue
 * is the fast, unserialized path).
 *
 * `serial: true` → `sg:<jobName>`, serialized against itself only.
 * `serial: { with: "chromium" }` → `sg:lane:chromium`, shared by every job name
 * naming that lane, so N job names serialize against ONE resource.
 */
export function queueNameFor(job: {
  name: string;
  serial?: SerialSpec;
}): string | undefined {
  if (!job.serial) return undefined;
  if (job.serial === true) return `${QUEUE_PREFIX}${job.name}`;
  return `${QUEUE_PREFIX}lane:${job.serial.with}`;
}

/** Everything one insertion of a job row is made of: the graphile task the row
 * sits on, and the `TaskSpec` carrying the rest of its columns. The two travel
 * together because both are derived from the job, and an insertion that took the
 * spec but re-typed the identifier would be exactly the drift this file exists
 * to prevent. */
export interface GraphileInsertion {
  /** The graphile task identifier — the job's hold-class task (`taskFor`). */
  readonly task: string;
  readonly spec: TaskSpec;
}

/**
 * Build the graphile insertion for one row of `job`. Everything a caller
 * legitimately varies per enqueue (`jobKey`, `runAt`, `maxAttempts`) is an
 * argument; the task identifier, the priority and the queue name deliberately
 * are NOT — they come from the job.
 */
export function graphileSpecFor(
  job: { name: string; hold: HoldClass; serial?: SerialSpec },
  opts: GraphileInsertOpts,
): GraphileInsertion {
  return {
    task: taskFor(job.hold),
    spec: {
      queueName: queueNameFor(job),
      priority: priorityFor(job.hold),
      jobKey: opts.jobKey ?? undefined,
      runAt: opts.runAt ?? undefined,
      maxAttempts: opts.maxAttempts,
    },
  };
}

export interface GraphileInsertOpts {
  jobKey?: string | null;
  runAt?: Date | null;
  maxAttempts?: number;
}
