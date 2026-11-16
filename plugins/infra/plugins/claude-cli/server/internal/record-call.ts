import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import {
  db,
  trimToNewest,
  writeAtomically,
  type DbExecutor,
} from "@plugins/database/server";
import { nullable } from "@plugins/database/plugins/sql-projection/server";
import type { ConversationModel } from "@plugins/conversations/plugins/model-provider/core";
import {
  usageLedgerUpsert,
  usageSourcesUpsert,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import {
  cliSpendSource,
  spendHourOf,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import { ensureModelRates } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import type { CallModelTokens } from "./call-tokens";
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
  /**
   * The account the call ran on — the one its tokens are filed under (`null`:
   * reading the active account failed, so the call never ran).
   */
  accountId: string | null;
  /**
   * The result's `total_cost_usd` (`null`: the call got no result) — the
   * call log's display value only: what the call cost is a read of its tokens
   * through the priced ledger (`claude_spend_hours_v`), like every other spend.
   */
  costUsd: number | null;
  /** The tokens the result reports, per model (`[]`: no result, or none used). */
  tokens: readonly CallModelTokens[];
  /** When the call was recorded — the ledger hour its tokens land in. */
  at: Date;
}

// Records a single claude-cli call. Swallows its own errors — recording must
// never affect the calling path.
export async function recordClaudeCliCall(
  input: RecordCallInput,
): Promise<void> {
  try {
    await writeClaudeCliCall(db, input);
    // eslint-disable-next-line promise-safety/no-bare-catch
  } catch (err) {
    console.warn("[claude-cli] failed to record call:", err);
  }
}

/**
 * The call's record, in one transaction: its log row, the trim to the most
 * recent N rows (cheap with the createdAt index), the ring horizon (so a
 * reader following it sees the ring as the call left it) — and what it used
 * filed under `cli:<sourceName>`: its tokens per model in the token ledger
 * (`claude_usage_hours`, priced by `claude_spend_hours_v`) with the source's
 * row. They land exactly when the call is recorded, written explicitly, never
 * rolled up from the log: the trim deletes log rows, and must not take their
 * usage. Then any model first seen is priced (`ensureModelRates`).
 */
export async function writeClaudeCliCall(
  exec: DbExecutor,
  input: RecordCallInput,
): Promise<void> {
  const { accountId } = input;
  const source = cliSpendSource(input.sourceName);
  const hour = spendHourOf(input.at);
  // No account: reading the active one failed, so the call never ran.
  const usage =
    accountId === null
      ? []
      : input.tokens.map((t) => ({
          accountId,
          hour,
          source,
          model: t.model,
          // `modelUsage` names no speed; a one-shot call is never fast mode.
          speed: "standard" as const,
          tokens: t.tokens,
        }));
  await exec.transaction(async (tx) => {
    // The log row and its tokens: one statement, so neither lands alone.
    await writeAtomically(tx, [
      tx.insert(_claudeCliCalls).values({
        model: input.model,
        sourceName: input.sourceName,
        sourceContext: input.sourceContext,
        prompt: input.prompt,
        system: input.system,
        output: input.output,
        error: input.error,
        durationMs: input.durationMs,
        correlationId: input.correlationId,
        costUsd: input.costUsd,
      }),
      usageLedgerUpsert(tx, usage),
      // A one-shot call is equin's own generation, run outside any project.
      usageSourcesUpsert(
        tx,
        usage.length === 0
          ? []
          : [{ source, projectDir: null, isRepo: true, title: null }],
      ),
    ]);
    await trimToNewest(tx, _claudeCliCalls, {
      key: _claudeCliCalls.id,
      newestFirst: _claudeCliCalls.createdAt,
      keep: RECENT_CALLS_LIMIT,
    });
    await writeRingHorizon(tx);
  });
  await ensureModelRates(
    exec,
    usage.map((row) => row.model),
  );
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
