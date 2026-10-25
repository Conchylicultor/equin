import { z } from "zod";
import { eq, isNull, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { requestUsageSync } from "./sync";
import {
  _conversationUsageExt,
  _conversationUsageFiles,
} from "../../server/internal/tables";

/**
 * One conversation's usage sync, as a job — how the backfill reaches
 * `requestUsageSync`. Keyed on the conversation, so re-enqueueing one
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
 * Prices what is still unpriced: the file rows whose tokens a price table could
 * not price when they were counted (a model newer than the table), and the
 * rows counted before costs were frozen. Every other row keeps the cost it was
 * priced at — a price-table refresh never re-prices history — so after an
 * ordinary refresh this finds a handful of conversations, or none.
 *
 * One job for the whole batch, syncing each in-process (serialized per
 * conversation with the live recount by `requestUsageSync`), rather than a
 * queued job per conversation: the work is a few ms each, and a serial queue
 * of thousands drains at the queue's fetch rate, not the work's. Restartable:
 * a priced row no longer matches, so a rerun picks up where it stopped.
 */
export const usageRepriceJob = defineJob({
  name: "conversations.usage.reprice",
  description:
    "Prices the conversation usage still unpriced — a model the price table did not know yet, or usage counted before costs were frozen.",
  // minutes: one sync per matching conversation, in a loop — a handful after a
  // price-table refresh, every conversation once on the first boot after costs
  // were frozen.
  hold: "minutes",
  inProcess:
    "Restartable from scratch: a conversation it priced no longer matches, so a rerun after a restart prices only what is left; local DB and file reads only.",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  slowThresholdMs: 600_000,
  run: async ({ ctx }) => {
    const rows = await db
      .selectDistinct({ id: _conversationUsageFiles.conversationId })
      .from(_conversationUsageFiles)
      .where(
        sql`${_conversationUsageFiles.costUsd} is null or ${_conversationUsageFiles.unpricedModels} <> '[]'::jsonb`,
      );
    for (const { id } of rows) {
      ctx.signal.throwIfAborted();
      await requestUsageSync(id);
    }
  },
});

// A declared warm-up rather than an `onReady` enqueue: deferred past
// serving-ready and throttled. `worktree` scope — usage lives in each backend's
// own DB; a fork inherits its source's rows, so it seeds only what was missing.
// The reprice rides along: it prices what an earlier boot left unpriced.
export const usageBackfillWarmup = defineWarmup({
  name: "conversations.usage.backfill",
  description:
    "Queues usage counts for conversations created before usage was tracked, and prices what is still unpriced.",
  scope: "worktree",
  run: async () => {
    await usageBackfillJob.enqueue({});
    await usageRepriceJob.enqueue({});
  },
});
