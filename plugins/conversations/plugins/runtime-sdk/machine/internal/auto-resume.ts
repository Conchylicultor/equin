import { z } from "zod";
import { getConfig } from "@plugins/config_v2/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { recordReport } from "@plugins/reports/plugins/engine/server";
import { autoResumeConfig, limitReached, planAutoResume } from "../../core";
import { usageLimitStoppedConversations } from "../../server/internal/rows";
import { nextLaunchAccount } from "./agent-process";
import { readClaudeUsage } from "./claude-usage";
import { resumeStopped } from "./resume-stopped";

/**
 * Auto-resume: send the resume turn to every agent a usage limit stopped, once
 * the account an agent restarted now would launch on has room. A singleton
 * that re-derives everything at each run and, while agents still wait,
 * enqueues itself again at the time the plan names (the limit's reset) — a
 * one-shot timer in the queue, never polling. Edges that start it: a usage
 * limit stopping an agent (the events consumer) and the setting changing (or
 * being read at boot).
 */
export const autoResumeJob = defineJob({
  name: "runtime-sdk.auto-resume",
  description:
    "Resumes agents a Claude usage limit stopped once the limit resets (or another account has room), when Resume agents when their usage limit resets is on.",
  hold: "minutes",
  inProcess:
    "Each resume restarts an agent process (seconds); a restart mid-run re-runs it from the DB, where a resumed agent is no longer stopped, so nothing is resumed twice.",
  input: z.object({}),
  event: z.never(),
  dedup: "singleton",
  run: async () => {
    if (!getConfig(autoResumeConfig).enabled) return;
    const now = Date.now();
    const plan = planAutoResume({
      stopped: await usageLimitStoppedConversations(),
      limit: limitReached(
        readClaudeUsage().byAccount[nextLaunchAccount()],
        now,
      ),
      now,
    });
    for (const result of await resumeStopped(plan.resumeNow)) {
      if (result.kind !== "failed") continue;
      await recordReport({
        kind: "crash",
        source: "server-caught",
        message: `Auto-resume: conversation ${result.id}, stopped at its usage limit, could not be resumed — ${result.message}`,
        data: {
          errorType: "SdkAutoResumeFailed",
          label: "runtime-sdk.auto-resume",
        },
      });
    }
    if (plan.nextAt !== null) await enqueueAutoResume(new Date(plan.nextAt));
  },
});

// Declared apart, with its type, so the job can enqueue itself.
async function enqueueAutoResume(runAt?: Date): Promise<void> {
  await autoResumeJob.enqueue({}, runAt ? { runAt } : undefined);
}

/** Plan auto-resume again now (a no-op run while the setting is off). */
export async function requestAutoResume(): Promise<void> {
  if (!getConfig(autoResumeConfig).enabled) return;
  await enqueueAutoResume();
}
