import { z } from "zod";
import { eq, isNull } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { requestUsageSync } from "./sync";
import { _conversationUsageExt } from "../../server/internal/tables";

/**
 * One conversation's usage sync, as a job — how the backfill and the reprice
 * reach `requestUsageSync`. Keyed on the conversation, so re-enqueueing one
 * that is already pending collapses; serial, so a backfill of every
 * conversation reads one conversation's transcripts at a time.
 */
export const usageSyncJob = defineJob({
  name: "conversations.usage.sync",
  description:
    "Recounts one conversation's token usage, cost and launched sub-agents from its transcripts.",
  // seconds: local reads of one conversation's transcripts (the appended bytes,
  // or every file of a chain that has not been read yet) — no network, no spawn.
  hold: "seconds",
  input: z.object({ conversationId: z.string() }),
  event: z.never(),
  dedup: { key: ({ conversationId }) => conversationId },
  serial: true,
  slowThresholdMs: 30_000,
  run: async ({ input: { conversationId } }) => {
    await requestUsageSync(conversationId);
  },
});

/**
 * Seeds the usage of every conversation that has none yet: those that predate
 * this plugin, and a fork's conversations its source had not counted. Every
 * conversation gets a row once synced (zeros when it has no transcript left),
 * so a later boot finds nothing to do.
 */
export const usageBackfillJob = defineJob({
  name: "conversations.usage.backfill",
  description:
    "Queues a usage count for every conversation that has not been counted yet.",
  // instant: one indexed anti-join and N queue inserts.
  hold: "instant",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  run: async () => {
    const rows = await db
      .select({ id: _conversations.id })
      .from(_conversations)
      .leftJoin(
        _conversationUsageExt,
        eq(_conversationUsageExt.conversationId, _conversations.id),
      )
      .where(isNull(_conversationUsageExt.conversationId));
    for (const { id } of rows)
      await usageSyncJob.enqueue({ conversationId: id });
  },
});

/**
 * Re-prices every counted conversation after the daily price-table refresh. A
 * sync recomputes the totals from the stored buckets with the current table and
 * writes only a conversation whose totals moved; it reads no transcript bytes
 * unless some were appended.
 */
export const usageRepriceJob = defineJob({
  name: "conversations.usage.reprice",
  description:
    "Re-prices every conversation's cost after the model price table is updated.",
  // instant: one indexed read and N queue inserts.
  hold: "instant",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  run: async () => {
    const rows = await db
      .select({ id: _conversationUsageExt.conversationId })
      .from(_conversationUsageExt);
    for (const { id } of rows)
      await usageSyncJob.enqueue({ conversationId: id });
  },
});

// A declared warm-up rather than an `onReady` enqueue: deferred past
// serving-ready and throttled. `worktree` scope — usage lives in each backend's
// own DB; a fork inherits its source's rows, so it seeds only what was missing.
export const usageBackfillWarmup = defineWarmup({
  name: "conversations.usage.backfill",
  description:
    "Queues usage counts for conversations created before usage was tracked.",
  scope: "worktree",
  run: async () => {
    await usageBackfillJob.enqueue({});
  },
});
