import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { db, trimToNewest } from "@plugins/database/server";
import { nullable } from "@plugins/database/plugins/sql-projection/server";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
import { _claudeCliCallHorizon, _claudeCliCalls } from "./tables";
import { CLAUDE_CLI_RING_ID, RECENT_CALLS_LIMIT } from "../../core/resources";

export interface RecordCallInput {
  model: ConversationModel;
  sourceName: string;
  sourceContext: Record<string, unknown> | null;
  prompt: string;
  system: string | null;
  output: string | null;
  error: string | null;
  durationMs: number;
  correlationId: string | null;
}

// Records a single claude-cli call. Swallows its own errors — recording must
// never affect the calling path. Trims the table to the most recent N rows
// after every insert (cheap with the createdAt index), and rewrites the ring
// horizon in the same transaction, so a reader following it sees the ring as
// the call left it.
export async function recordClaudeCliCall(
  input: RecordCallInput,
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await tx.insert(_claudeCliCalls).values({
      model: input.model,
      sourceName: input.sourceName,
      sourceContext: input.sourceContext,
      prompt: input.prompt,
      system: input.system,
      output: input.output,
      error: input.error,
      durationMs: input.durationMs,
      correlationId: input.correlationId,
    });
      await trimToNewest(tx, _claudeCliCalls, {
        key: _claudeCliCalls.id,
        newestFirst: _claudeCliCalls.createdAt,
        keep: RECENT_CALLS_LIMIT,
      });
      await writeRingHorizon(tx);
    });
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch (err) {
    console.warn("[claude-cli] failed to record call:", err);
  }
}

type Executor = Pick<NodePgDatabase, "insert" | "select">;

/**
 * Rewrite the ring horizon from the log as it stands: its size and its
 * oldest call. Run by the recorder after each trim, and at boot (the log may
 * have moved without it — a fork excludes both tables, an older build kept no
 * horizon). An unchanged horizon is not rewritten (`setWhere`), so the change
 * feed moves no reader of it.
 */
export async function writeRingHorizon(executor: Executor): Promise<void> {
  const h = _claudeCliCallHorizon;
  await executor
    .insert(h)
    .select(
      executor
        .select({
          id: sql`${CLAUDE_CLI_RING_ID}`.mapWith(h.id).as("id"),
          total: sql`count(*)::int`.mapWith(h.total).as("total"),
          oldest: sql`min(${_claudeCliCalls.createdAt})`
            .mapWith(nullable(h.oldest))
            .as("oldest"),
        })
        .from(_claudeCliCalls),
    )
    .onConflictDoUpdate({
      target: h.id,
      set: { total: sql`excluded.total`, oldest: sql`excluded.oldest` },
      setWhere: sql`(${h.total}, ${h.oldest}) IS DISTINCT FROM (excluded.total, excluded.oldest)`,
    });
}
