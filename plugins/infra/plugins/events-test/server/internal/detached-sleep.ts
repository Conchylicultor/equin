import { z } from "zod";
import { NonRetryableError } from "@plugins/infra/plugins/jobs/server";
import { defineSupervisedJob } from "@plugins/infra/plugins/jobs/plugins/supervised-job/server";
import { implement } from "@plugins/infra/plugins/endpoints/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { detachedSleepEventsTest } from "../../shared/endpoints";

// Restart-survival harness for `defineSupervisedJob`'s `run` body: the sleep
// runs in a detached `./singularity supervised-exec` child, so a
// `./singularity build` mid-run must leave the child alive and the workflow
// must still close its `supervised_job_runs` row. `fail` exercises the
// dead-letter policy (non-retryable ⇒ one attempt; retryable ⇒ both attempts).
const detachedSleepLog = defineLogSink({
  id: "events-test-detached-sleep",
  description:
    "events-test detached-sleep harness: transcript of the supervised child's progress lines.",
});

export const detachedSleep = defineSupervisedJob({
  name: "events-test.detached-sleep",
  description:
    "Test probe that sleeps in a detached child process to verify supervised jobs survive a backend restart and fail as configured.",
  input: z.object({
    seconds: z.number().int().min(0).max(3600).default(90),
    fail: z.enum(["none", "retryable", "non-retryable"]).default("none"),
  }),
  channel: detachedSleepLog,
  runAttempts: 2,
  async run({ seconds, fail }, { runId, log }) {
    log(
      `detached-sleep ${runId}: start pid=${process.pid} seconds=${seconds} fail=${fail}`,
    );
    for (let elapsed = 0; elapsed < seconds; elapsed += 5) {
      await Bun.sleep(Math.min(5, seconds - elapsed) * 1000);
      log(
        `detached-sleep ${runId}: ${Math.min(elapsed + 5, seconds)}/${seconds}s`,
      );
    }
    if (fail === "non-retryable")
      throw new NonRetryableError(
        "detached-sleep: requested non-retryable failure",
      );
    if (fail === "retryable")
      throw new Error("detached-sleep: requested retryable failure");
    log(`detached-sleep ${runId}: done`);
  },
});

export const handleDetachedSleep = implement(
  detachedSleepEventsTest,
  async ({ body }) => {
    await detachedSleep.enqueue({
      seconds: body.seconds ?? 90,
      fail: body.fail ?? "none",
    });
    return { ok: true as const };
  },
);
