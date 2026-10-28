import { eq, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { resolveConversationTranscriptPaths } from "@plugins/conversations/plugins/transcript-watcher/server";
import {
  listSubagentEntries,
  subagentDirOf,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/machine";
import { currentPriceTable } from "@plugins/stats/plugins/cost/server";
import type { SeenEntry } from "@plugins/stats/plugins/cost/core";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import {
  advanceFile,
  isLegacyScan,
  priceFile,
  totalsOf,
  type FilePricing,
  type FileScan,
  type PricedFile,
} from "./scan";
import {
  _conversationUsageFiles,
  conversationUsage,
  type UsageFileKind,
} from "../../server/internal/tables";

// ─── What this is ──────────────────────────────────────────────────────────────
//
// The one code path that brings a conversation's usage totals up to date, for
// a live append and for the backfill alike:
//
//   1. resolve its files — the ANCHORED session chain (never raw session ids:
//      that derivation is the ownership guard) and every sub-agent below it;
//   2. fold each file's NEW bytes into its stored scan state (an append read),
//      or — when a session file joins the chain, or was counted before a
//      message counted at its largest output (`isLegacyScan`) — re-read every
//      session file through ONE seen-set, because a resumed / forked session's
//      new file copies the history before it;
//   3. price each file row's newly counted tokens with today's price table —
//      what was priced before keeps its cost (`priceFile`), so a price change
//      never re-prices history — and price a model it could not price before
//      once the table knows it;
//   4. sum every file row (vanished files included — the totals never shrink
//      when Claude Code sweeps a transcript) and write only what changed.
//
// Counting and pricing are stats/cost's (`foldUsageEntry`, `priceBucket`), so a
// conversation's Cost column and the Stats → Cost page agree while the price
// table holds still; after a known model's price changes, the Cost column keeps
// what the tokens cost when they were spent, the page re-prices at today's.

/**
 * Bring one conversation's usage up to date (see the header). A conversation
 * that no longer exists is skipped: its session chain outlives it, so a write
 * event can still name it, and its rows went with it (FK CASCADE).
 *
 * Not safe to run twice at once for one conversation — go through
 * {@link requestUsageSync}, which serializes per conversation.
 */
async function syncConversationUsage(conversationId: string): Promise<void> {
  const [exists] = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .where(eq(_conversations.id, conversationId));
  if (!exists) return;

  const sessionPaths = await resolveConversationTranscriptPaths(conversationId);
  const agents = await listSubagentEntries(sessionPaths.map(subagentDirOf));
  const stored = await db
    .select()
    .from(_conversationUsageFiles)
    .where(eq(_conversationUsageFiles.conversationId, conversationId));
  const storedByPath = new Map<string, PricedFile>(
    stored.map((r) => [r.path, r]),
  );
  const byPath = new Map<string, FileScan>(stored.map((r) => [r.path, r]));

  const changed: FileScan[] = [];
  const advance = async (
    path: string,
    kind: UsageFileKind,
    chainSeen?: Map<string, SeenEntry>,
  ): Promise<void> => {
    const prev = byPath.get(path);
    const next = await advanceFile(path, kind, prev, chainSeen);
    if (next !== null && next !== prev) changed.push(next);
  };

  // A session file new to the chain, or one counted by the legacy fold
  // (`isLegacyScan`), re-reads the whole chain through one seen-set.
  const recountChain = sessionPaths.some((p) => {
    const scan = byPath.get(p);
    return scan === undefined || isLegacyScan(scan);
  });
  if (recountChain) {
    const chainSeen = new Map<string, SeenEntry>();
    for (const path of sessionPaths) await advance(path, "session", chainSeen);
  } else {
    for (const path of sessionPaths) await advance(path, "session");
  }
  for (const agent of agents) await advance(agent.transcriptPath, "subagent");
  // A legacy row this pass did not reach (a sub-agent whose transcript is gone,
  // so no longer listed) cannot be recounted: it keeps its tokens and drops its
  // tail, as `advanceFile` does for a vanished file it is handed.
  const reached = new Set([
    ...sessionPaths,
    ...agents.map((a) => a.transcriptPath),
  ]);
  for (const scan of byPath.values()) {
    if (!reached.has(scan.path) && isLegacyScan(scan))
      changed.push({ ...scan, tailHashes: [] });
  }

  for (const scan of changed) byPath.set(scan.path, scan);
  const table = await currentPriceTable();
  const rows: (FileScan & FilePricing)[] = [];
  const toWrite: (FileScan & FilePricing)[] = [];
  const changedPaths = new Set(changed.map((scan) => scan.path));
  for (const scan of byPath.values()) {
    const prev = storedByPath.get(scan.path);
    const row = { ...scan, ...priceFile(prev, scan.buckets, table) };
    rows.push(row);
    const repriced =
      prev === undefined ||
      prev.costUsd !== row.costUsd ||
      prev.unpricedModels.join("\0") !== row.unpricedModels.join("\0");
    if (changedPaths.has(scan.path) || repriced) toWrite.push(row);
  }
  const totals = totalsOf(rows);
  const current = await conversationUsage.get(conversationId);
  const same =
    current !== undefined &&
    current.costUsd === totals.costUsd &&
    current.tokens === totals.tokens &&
    current.cacheReadTokens === totals.cacheReadTokens &&
    current.agentCount === totals.agentCount;
  if (toWrite.length === 0 && same) return;

  await db.transaction(async (tx) => {
    if (toWrite.length > 0) {
      await tx
        .insert(_conversationUsageFiles)
        .values(toWrite.map((row) => ({ conversationId, ...row })))
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
            costUsd: sql`excluded.cost_usd`,
            unpricedModels: sql`excluded.unpriced_models`,
          },
        });
    }
    if (!same) await conversationUsage.upsert(conversationId, totals, tx);
  });
}

// Per-conversation serialization: a sync already running for a conversation
// absorbs every request that arrives meanwhile into ONE trailing re-run, so a
// burst of appends (a streaming turn writes a line per content block) costs at
// most two passes, and two passes never race on the same rows.
const running = new Map<string, { again: boolean; done: Promise<void> }>();

/**
 * Bring a conversation's usage up to date, coalesced with any sync of it
 * already in flight. Resolves once a pass that started after this call has
 * finished.
 */
export function requestUsageSync(conversationId: string): Promise<void> {
  const inFlight = running.get(conversationId);
  if (inFlight) {
    inFlight.again = true;
    return inFlight.done;
  }
  const entry = { again: false, done: Promise.resolve() };
  entry.done = (async () => {
    try {
      do {
        entry.again = false;
        await syncConversationUsage(conversationId);
      } while (entry.again);
    } finally {
      running.delete(conversationId);
    }
  })();
  running.set(conversationId, entry);
  return entry.done;
}
