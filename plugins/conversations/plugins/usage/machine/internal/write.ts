import { and, eq, inArray, sql } from "drizzle-orm";
import { writeAtomically, type DbExecutor } from "@plugins/database/server";
import {
  usageLedgerDropSources,
  usageLedgerUpsert,
  usageSourcesUpsert,
  type UsageLedgerRow,
  type UsageSourceRow,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import {
  conversationSpendSource,
  type SpendSource,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import type { FileScan, TranscriptScan } from "./scan";
import {
  _claudeTranscriptScans,
  _conversationUsageFiles,
  conversationUsage,
} from "../../server/internal/tables";

/**
 * Tokens a sync counted (a whole-token delta, `tokenDelta`), to add to the
 * token ledger under the conversation's own source, which `writeUsage` stamps.
 */
export type AccountUsage = Omit<UsageLedgerRow, "source">;

/** What a sync knows of its source's row (`claude_usage_sources`). */
export type ConversationSourceFacts = Omit<UsageSourceRow, "source">;

/**
 * Write what one sync changed: the file rows it advanced, the conversation's
 * agent count (`null` when it did not move; its cost and tokens follow the
 * ledger rows written here, derived by the database), the tokens it counted
 * per account, hour, model and speed under the conversation's `conv:` source
 * (added to what the ledger holds, `usageLedgerUpsert`) and the source's row
 * (`usageSourcesUpsert`, `null`: unchanged since this process wrote it) — in
 * ONE statement. `adopted`: the `session:` sources of the sessions this pass
 * counts for the first time that may have been scanned while no conversation
 * owned them — their ledger rows, source rows and scan rows go in the same
 * statement, so each transcript's tokens are in the ledger once. `removed`:
 * file rows of this conversation the pass no longer keeps — a transcript's row
 * under its old spelling, taken over under its new path or dropped as a second
 * count (`rekeyStoredRows`); the tokens a drop gives back are in `usage`.
 *
 * Never a transaction of round trips: between two statements the server sits
 * idle in transaction, holding the file rows' locks while the app thinks — the
 * window a lost connection left open for 5 h on 2026-11-03, queueing every
 * later sync behind it. A data-modifying CTE runs every upsert atomically in
 * one round trip (`writeAtomically`), each firing its own triggers (derived
 * `updatedAt`, the change feed, the Cost column's). Each arm writes a different
 * table and none reads another's result, so the one snapshot they share costs
 * nothing. Atomic matters for the ledger: a write that fails moves neither the
 * file rows nor the tokens, so the next pass counts — and files — the same
 * delta once.
 */
export async function writeUsage(
  exec: DbExecutor,
  conversationId: string,
  files: readonly FileScan[],
  agentCount: number | null,
  usage: readonly AccountUsage[] = [],
  source: ConversationSourceFacts | null = null,
  adopted: readonly SpendSource[] = [],
  removed: readonly string[] = [],
): Promise<void> {
  const ledgerSource = conversationSpendSource(conversationId);
  await writeAtomically(exec, [
    ...usageLedgerDropSources(exec, adopted),
    removed.length > 0
      ? exec
          .delete(_conversationUsageFiles)
          .where(
            and(
              eq(_conversationUsageFiles.conversationId, conversationId),
              inArray(_conversationUsageFiles.path, [...removed]),
            ),
          )
      : null,
    adopted.length > 0
      ? exec
          .delete(_claudeTranscriptScans)
          .where(inArray(_claudeTranscriptScans.source, [...adopted]))
      : null,
    files.length > 0
      ? exec
          .insert(_conversationUsageFiles)
          .values(files.map((row) => ({ conversationId, ...row })))
          .onConflictDoUpdate({
            target: [
              _conversationUsageFiles.conversationId,
              _conversationUsageFiles.path,
            ],
            set: {
              kind: sql`excluded.kind`,
              offset: sql`excluded.offset`,
              buckets: sql`excluded.buckets`,
              tailHashes: sql`excluded.tail_hashes`,
            },
          })
      : null,
    usageLedgerUpsert(
      exec,
      usage.map((row) => ({ ...row, source: ledgerSource })),
    ),
    usageSourcesUpsert(
      exec,
      source === null ? [] : [{ ...source, source: ledgerSource }],
    ),
    // The agent count only — cost and tokens are derived from the ledger rows
    // above, by the database (server/internal/cost-triggers.ts).
    agentCount !== null
      ? conversationUsage.upsertQuery(conversationId, { agentCount })
      : null,
  ]);
}

/**
 * Write what one ledger-only pass over a session's transcripts read (the
 * transcripts no conversation owns, `session-sync.ts`): the scan rows it
 * advanced, the tokens it counted under the session's `source`
 * (`usageLedgerUpsert`; a whole-source recount also carries the negated rows
 * it takes back) and the source's row (`null`: unchanged) — in ONE statement,
 * so a failed write moves neither the offsets nor the ledger, and the next pass
 * reads — and files — the same bytes once.
 */
export async function writeSessionUsage(
  exec: DbExecutor,
  source: SpendSource,
  scans: readonly TranscriptScan[],
  usage: readonly AccountUsage[],
  facts: ConversationSourceFacts | null,
): Promise<void> {
  await writeAtomically(exec, [
    scans.length > 0
      ? exec
          .insert(_claudeTranscriptScans)
          .values(scans.map((scan) => ({ ...scan, source })))
          .onConflictDoUpdate({
            target: _claudeTranscriptScans.path,
            set: {
              source: sql`excluded.source`,
              kind: sql`excluded.kind`,
              offset: sql`excluded.offset`,
              tailHashes: sql`excluded.tail_hashes`,
            },
          })
      : null,
    usageLedgerUpsert(
      exec,
      usage.map((row) => ({ ...row, source })),
    ),
    usageSourcesUpsert(exec, facts === null ? [] : [{ ...facts, source }]),
  ]);
}
