import { z } from "zod";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import {
  NonRetryableError,
  defineJob,
  reachableSlots,
} from "@plugins/infra/plugins/jobs/server";
import { queueSaturateEventsTest } from "../../shared/endpoints";

// A load generator, not a regression harness: it puts the job queue into the
// states queue observability exists to report — a full `minutes` class with a
// job left waiting behind it, and a freshly dead-lettered job — and returns as
// soon as the rows are durable. Nothing is asserted; the point is to look at
// the health report's Job queue row (and Debug → Queue) turn amber, then watch
// it return to green as the sleepers drain.
//
// Everything goes through `enqueue()`. The rows land on the task and priority
// their hold class declares, exactly like production work, so what the
// observability sees is the real reservation — not a hand-typed insert that
// `jobs:no-raw-addjob` forbids anyway.

const SLEEPER_HOLD = "minutes";
const DEFAULT_SLEEP_MS = 90_000;

// Cut every sleeper short when this backend shuts down.
//
// `ctx.signal` is deliberately the per-run DEADLINE, never shutdown (see its doc
// in jobs/registry.ts), and graphile's graceful shutdown waits for running
// handlers to settle. So without this, a `./equin build` restart during a
// saturation run would sit for the rest of every sleeper's `sleepMs`. Plugin
// `onShutdown` hooks run concurrently, so this fires while the jobs plugin's
// `stopWorkers()` is waiting on these very handlers.
//
// A sleeper cut short by shutdown RETURNS rather than throws: it only exists to
// occupy a slot while this process is alive, so there is nothing to retry and
// no failure to report.
const shutdown = new AbortController();

export function abortSaturationSleepers(): void {
  shutdown.abort();
}

/** Resolves after `ms`, or as soon as `signal` aborts — whichever is first. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export const saturateSleeper = defineJob({
  name: "events_test.saturate-sleeper",
  description:
    "Test probe that occupies a worker slot for a chosen duration to verify the queue reports saturation.",
  // minutes: the handler holds its slot for a caller-chosen duration (up to the
  // endpoint's 20-min cap), and nothing shorter bounds it. It is also the point:
  // `minutes` rows reach only the wide runner's slots, so a handful of these
  // fill that class while shorter classes keep their reserved slots.
  hold: SLEEPER_HOLD,
  inProcess:
    "A test sleeper does no work: killed mid-sleep it has nothing to redo, and " +
    "holding a `minutes` worker slot in process is the whole point of it.",
  input: z.object({ sleepMs: z.number().int().min(0) }),
  event: z.never(),
  // Every call enqueues fresh rows: a singleton would collapse the sleepers
  // whose number is the whole point.
  dedup: "none",
  // A sleeper that failed has nothing to retry — a second attempt would only
  // re-occupy a slot the caller never asked for.
  maxAttempts: 1,
  run: async ({ input: { sleepMs }, ctx }) => {
    await sleep(sleepMs, AbortSignal.any([ctx.signal, shutdown.signal]));
    // Past the class deadline: fail loudly, attributed to this run. With the
    // endpoint's cap far below the `minutes` deadline this is not expected, but
    // a handler that ignored its signal is exactly the wedge the deadline exists
    // to stop.
    ctx.signal.throwIfAborted();
  },
});

export const deadLetterProbe = defineJob({
  name: "events_test.dead-letter",
  description:
    "Test probe that always fails to verify a failing job is dead-lettered and reported.",
  // instant: it throws before doing anything.
  hold: "instant",
  input: z.object({}),
  event: z.never(),
  dedup: "none",
  run: () => {
    // Deterministic by construction, so the worker collapses the retry budget
    // and graphile dead-letters the row after this one attempt — reported, and
    // listed by queue-health, like any real dead-letter.
    throw new NonRetryableError(
      "events-test queue-saturate: deliberate dead-letter",
    );
  },
});

export const handleQueueSaturate = implement(
  queueSaturateEventsTest,
  async ({ body }) => {
    const minutesSlots = reachableSlots(SLEEPER_HOLD);
    const count = body.count ?? minutesSlots + 1;
    const sleepMs = body.sleepMs ?? DEFAULT_SLEEP_MS;
    const backdateMs = body.backdateMs ?? 0;
    // One back-dated `run_at` for every sleeper, not just the one that will
    // wait. graphile fetches `order by priority, run_at`, so back-dating a single
    // row would make it the FIRST one picked up — running, not waiting — and
    // which row ends up waiting is decided by free slots, not by this code.
    // The cost: the sleepers that are picked up also report a pickup time of
    // ≈ `backdateMs`, since they claim to have been due that long ago.
    const runAt =
      backdateMs > 0 ? new Date(Date.now() - backdateMs) : undefined;

    const sleeperJobIds: string[] = [];
    for (let i = 0; i < count; i++) {
      const { jobId } = await saturateSleeper.enqueue({ sleepMs }, { runAt });
      sleeperJobIds.push(jobId);
    }
    const deadJobId =
      (body.dead ?? true) ? (await deadLetterProbe.enqueue({})).jobId : null;

    return {
      sleeperJobIds,
      deadJobId,
      minutesSlots,
      sleepMs,
      runAt: runAt?.toISOString() ?? null,
    };
  },
);
