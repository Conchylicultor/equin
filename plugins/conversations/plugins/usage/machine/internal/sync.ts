import { eq, sql } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { resolveConversationTranscriptPaths } from "@plugins/conversations/plugins/transcript-watcher/server";
import {
  listSubagentEntries,
  subagentDirOf,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/machine";
import { currentPriceTable } from "@plugins/stats/plugins/cost/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { advanceFile, totalsOf, type FileScan } from "./scan";
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
//      or — when a session file joins the chain — re-read every session file
//      through ONE seen-set, because a resumed / forked session's new file
//      copies the history before it;
//   3. sum every file row (vanished files included — the totals never shrink
//      when Claude Code sweeps a transcript), price it, and write only what
//      changed.
//
// Counting and pricing are stats/cost's (`foldUsageEntry`, `priceBucket`), so a
// conversation's Cost column and the Stats → Cost page agree by construction.

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
  const byPath = new Map<string, FileScan>(stored.map((r) => [r.path, r]));

  const changed: FileScan[] = [];
  const advance = async (
    path: string,
    kind: UsageFileKind,
    chainSeen?: Set<string>,
  ): Promise<void> => {
    const prev = byPath.get(path);
    const next = await advanceFile(path, kind, prev, chainSeen);
    if (next !== null && next !== prev) changed.push(next);
  };

  if (sessionPaths.some((p) => !byPath.has(p))) {
    const chainSeen = new Set<string>();
    for (const path of sessionPaths) await advance(path, "session", chainSeen);
  } else {
    for (const path of sessionPaths) await advance(path, "session");
  }
  for (const agent of agents) await advance(agent.transcriptPath, "subagent");

  for (const scan of changed) byPath.set(scan.path, scan);
  const totals = totalsOf(byPath.values(), await currentPriceTable());
  const current = await conversationUsage.get(conversationId);
  const same =
    current !== undefined &&
    current.costUsd === totals.costUsd &&
    current.tokens === totals.tokens &&
    current.cacheReadTokens === totals.cacheReadTokens &&
    current.agentCount === totals.agentCount;
  if (changed.length === 0 && same) return;

  await db.transaction(async (tx) => {
    if (changed.length > 0) {
      await tx
        .insert(_conversationUsageFiles)
        .values(changed.map((scan) => ({ conversationId, ...scan })))
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
