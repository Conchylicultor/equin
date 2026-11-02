import { sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
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
      await tx.execute(sql`
      DELETE FROM claude_cli_calls
      WHERE id NOT IN (
        SELECT id FROM claude_cli_calls
        ORDER BY created_at DESC
        LIMIT ${RECENT_CALLS_LIMIT}
      )
    `);
      await writeRingHorizon(tx);
    });
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch (err) {
    console.warn("[claude-cli] failed to record call:", err);
  }
}

type Executor = Pick<typeof db, "execute">;

/**
 * Rewrite the ring horizon from the log as it stands: its size and its
 * oldest call. Run by the recorder after each trim, and at boot (the log may
 * have moved without it — a fork excludes both tables, an older build kept no
 * horizon).
 */
export async function writeRingHorizon(executor: Executor): Promise<void> {
  await executor.execute(sql`
    INSERT INTO ${_claudeCliCallHorizon} (id, total, oldest)
    SELECT ${CLAUDE_CLI_RING_ID}, count(*)::int, min(created_at)
    FROM ${_claudeCliCalls}
    ON CONFLICT (id) DO UPDATE
      SET total = EXCLUDED.total, oldest = EXCLUDED.oldest
      WHERE (${_claudeCliCallHorizon}.total, ${_claudeCliCallHorizon}.oldest)
        IS DISTINCT FROM (EXCLUDED.total, EXCLUDED.oldest)
  `);
}
