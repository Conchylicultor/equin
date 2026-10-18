import { z } from "zod";
import { basename } from "path";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { getConversation } from "@plugins/tasks/plugins/tasks-core/server";
import {
  asNamespace,
  namespaceUrl,
} from "@plugins/infra/plugins/namespace/core";
import {
  HOLD_CLASSES,
  HOLD_SPECS,
  LEGACY_JOB_TASK,
  RUNNERS,
  TOTAL_JOB_SLOTS,
  reachableSlots,
} from "@plugins/infra/plugins/jobs/server";
import { QueueHealthSummarySchema } from "../../core";

// The ladder, rendered from the jobs class table rather than restated in prose.
// The description is what an agent reads to know WHICH QUESTION TO ASK about a
// stalled queue, so a slot count that had drifted from the runtime would be
// worse than no number at all — hence every figure below is interpolated.
const runnerLadder = RUNNERS.map(
  (r) =>
    `  - runner \`${r.id}\` — ${r.concurrency} slot(s), serves ${r.serves
      .map((h) => `\`${h}\``)
      .join(" + ")}${
      r.legacy ? ` (plus the legacy \`${LEGACY_JOB_TASK}\` task)` : ""
    }`,
).join("\n");

// `HOLD_CLASSES` is ordered shortest → longest, so the ends of it are the two
// classes the reservation is actually between. Read rather than named, so the
// sentence below stays true if a class is ever added at either end.
const shortest = HOLD_CLASSES[0];
const longest = HOLD_CLASSES[HOLD_CLASSES.length - 1]!;

const classLadder = HOLD_CLASSES.map(
  (h) =>
    `  - \`${h}\` — reachable from ${reachableSlots(
      h,
    )} of the ${TOTAL_JOB_SLOTS} slots; declared work ceiling ${
      HOLD_SPECS[h].ceilingMs / 1000
    }s`,
).join("\n");

export const queueHealthTool = Mcp.tool({
  name: "get_queue_health",
  description: `Attributed health of a worktree's graphile-worker job queue: how deep each hold class's backlog is, which jobs dominate it, which jobs are holding worker slots the longest, and which jobs are terminally dead. Use to diagnose why the queue is backed up or why newly-enqueued work is not running.

**The worker is NOT one shared pool.** Every job declares a \`hold\` class — the timescale one run may occupy a worker slot — and that class decides which graphile task the row is inserted on. ${
    RUNNERS.length
  } runners with NESTED task lists drain those tasks, for ${TOTAL_JOB_SLOTS} slots in total:

${runnerLadder}

So each class can be picked up by a different number of slots:

${classLadder}

The nesting is the whole point, and it is one-way: **a class's spare capacity is usable by shorter classes, never the reverse.** Idle \`${longest}\` slots will happily run \`${shortest}\` work, but a \`${longest}\` job can never touch the ${
    reachableSlots(shortest) - reachableSlots(longest)
  } slots reserved below it — so long work can never take the last slot short work needs. When you are asking "why is this job not running", the question is whether **its own class** is saturated, not whether the queue is busy.

Two things this data deliberately cannot tell you:
- **Which runner holds a given locked row.** The three runners share one job table and graphile records no runner id per row, so \`classes[].lockedCount\` counts locked ROWS of that class — not slots occupied in that tier. "Is the seconds tier full" has no answer here; "did anything in this class drain" does (compare \`oldestOverdueMs\` across two calls — if it grows by exactly the elapsed time, the head of that class never moved).
- **Why a slot is held.** \`lockedForMs\` is wall-clock HOLD, which includes time the handler spent blocked on an admission gate entered after graphile handed it the slot. A job can hold a slot for a minute to do 250ms of work. That split is measured separately and filed as a \`queue-slot-blocked\` report (see Debug → Reports).

Fields:
- \`concurrency\` — total worker slots across every runner (the all-classes rollup; ${TOTAL_JOB_SLOTS} today).
- \`backlog\` — all-classes aggregate: \`readyCount\` (overdue, unlocked, retry-eligible jobs waiting), \`lockedCount\` (jobs currently running), \`oldestOverdueMs\` (age of the oldest ready job).
- \`classes\` — the same three numbers **per hold class**, plus \`reachableSlots\`: **which tier is actually backed up.** A deep \`instant\` backlog with idle \`minutes\` work means something is wrong with the reservation; a deep \`minutes\` backlog with 4 locked \`minutes\` rows is just heavy work queued behind heavy work. Absent when the target backend predates hold classes.
- \`byJobName\` — top-N breakdown of the ready backlog by jobName and class (\`hold\`, \`readyCount\`, \`oldestOverdueMs\`): **who is filling the ready queue.**
- \`running\` — currently-locked jobs, longest-held slot first (\`jobName\`, \`hold\`, \`jobId\`, \`lockedForMs\`, \`lockedBy\`, \`alive\`): **who holds the slots.** \`alive\` is exact worker liveness (a granted advisory lock), not an inference from duration — a long \`lockedForMs\` with \`alive: true\` is a healthy slow job, the same duration with \`alive: false\` is an abandoned row the stuck-lock sweeper will reclaim.
- \`dead\` — terminally-failed jobs per jobName (\`deadCount\`, \`attempts\`/\`maxAttempts\`, \`lastError\`, \`sampleJobId\`): **the terminal failures** clogging the queue.

Default: reads the current conversation's own worktree. Pass \`worktree\` to target a different one (e.g. "att-1778089188-7uvf" or "singularity" for main).`,
  inputSchema: {
    worktree: z
      .string()
      .optional()
      .describe(
        "Target worktree name. Defaults to the conversation's own worktree.",
      ),
  },
  async handler({ worktree }, { conversationId }) {
    let raw: string;
    if (worktree) {
      raw = worktree;
    } else {
      const conv = await getConversation(conversationId);
      if (!conv) throw new Error(`Unknown conversation "${conversationId}"`);
      raw = basename(conv.worktreePath);
    }

    // A tool argument is a serialization boundary, and the name goes into a URL
    // the gateway resolves — so it is validated against the one grammar the
    // gateway itself accepts, not a local approximation of it.
    const worktreeName = asNamespace(raw);

    // Always read through the gateway, which only ever proxies to the worktree's
    // live backend — reading this process's own DB would report the calling
    // worktree, not the requested target.
    const url = namespaceUrl(worktreeName, "/api/debug/queue-health/summary");
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(
        `queue-health summary fetch failed (${res.status}) for worktree "${worktreeName}"`,
      );
    }
    const summary = QueueHealthSummarySchema.parse(await res.json());

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(summary, null, 2),
        },
      ],
    };
  },
});
