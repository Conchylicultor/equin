import { basename } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { resolveConversationTranscriptPaths } from "@plugins/conversations/plugins/transcript-watcher/server";
import { conversationRunningAccount } from "@plugins/conversations/server";
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
  type UsageTotals,
} from "./scan";
import { writeUsage, type AccountSpend } from "./write";
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
//      when Claude Code sweeps a transcript) and write only what changed;
//   5. file the cost this pass priced under the Claude account that spent it
//      (`conversation_usage_account_days`): a live pass runs right after the
//      agent's own append, so the account its runtime runs it on NOW is the
//      one the tokens were drawn from. A job pass (backfill, reprice) files
//      nothing — it cannot know which account spent what it counts.
//
// Counting and pricing are stats/cost's (`foldUsageEntry`, `priceBucket`), so a
// conversation's Cost column and the Stats → Cost page agree while the price
// table holds still; after a known model's price changes, the Cost column keeps
// what the tokens cost when they were spent, the page re-prices at today's.

/**
 * One conversation's usage state as this process last read or wrote it: its
 * chain's transcript files as last resolved, every file row, and the totals.
 *
 * Held, not re-read per append: this module is the ONLY writer of
 * `conversation_usage_files` and of the totals (every path — the live recount,
 * the backfill, the reprice — goes through {@link requestUsageSync}, serialized
 * per conversation), so what it wrote is what the DB holds. A live append then
 * costs the bytes it appended and one write — not a re-read of the
 * conversation, its chain, its file rows and its totals every time
 * (2026-11-06: ~8 DB round trips per append, 2,023 syncs in 52 min on main).
 */
interface UsageState {
  sessionPaths: string[];
  files: Map<string, PricedFile>;
  totals: UsageTotals | undefined;
  /**
   * The Claude account a live pass last found the conversation's agent on —
   * the account for tokens appended just before the agent exited, which the
   * pass after the exit counts with no agent left to ask.
   */
  account: string | null;
}

/**
 * The live recount's held states (see {@link UsageState}), least recently
 * synced first. Bounded at {@link HELD_MAX}: the conversations being written
 * now are a handful, and an evicted one only pays a cold load on its next
 * write — while a deleted or long-idle one is never reached again (the owner
 * lookup names existing conversations only) and would otherwise stay for the
 * process's life.
 */
const held = new Map<string, UsageState>();
const HELD_MAX = 256;

function hold(conversationId: string, state: UsageState): void {
  held.delete(conversationId);
  held.set(conversationId, state);
  for (const oldest of held.keys()) {
    if (held.size <= HELD_MAX) break;
    held.delete(oldest);
  }
}

/** A transcript file's session id (`<sessionId>.jsonl`). */
const sessionIdOf = (path: string): string => basename(path, ".jsonl");

/** Read a conversation's state from the DB, or null when it no longer exists. */
async function loadState(conversationId: string): Promise<UsageState | null> {
  const [exists] = await db
    .select({ id: _conversations.id })
    .from(_conversations)
    .where(eq(_conversations.id, conversationId));
  if (!exists) return null;
  const [sessionPaths, stored, totals] = await Promise.all([
    resolveConversationTranscriptPaths(conversationId),
    db
      .select()
      .from(_conversationUsageFiles)
      .where(eq(_conversationUsageFiles.conversationId, conversationId)),
    conversationUsage.get(conversationId),
  ]);
  return {
    sessionPaths,
    files: new Map(stored.map((r) => [r.path, r])),
    totals,
    account: null,
  };
}

/**
 * What a sync was asked for: the session ids whose transcripts were written
 * (the live recount — the conversation is known to exist, its owner lookup
 * read it), or `"reload"` (a job: read everything from the DB).
 */
type SyncCause = ReadonlySet<string> | "reload";

/**
 * Bring one conversation's usage up to date (see the header). A conversation
 * that no longer exists is skipped: its session chain outlives it, so a job
 * can still name it, and its rows went with it (FK CASCADE).
 *
 * Not safe to run twice at once for one conversation — go through
 * {@link requestUsageSync}, which serializes per conversation.
 */
async function syncConversationUsage(
  conversationId: string,
  cause: SyncCause,
): Promise<void> {
  const kept = cause === "reload" ? undefined : held.get(conversationId);
  const state = kept ?? (await loadState(conversationId));
  if (state === null) {
    held.delete(conversationId);
    return;
  }
  // The chain moves only by adopting a session, whose transcript is then
  // written: a write naming a session the held paths do not resolve re-reads
  // it (also a session recorded before its file existed).
  if (kept !== undefined && cause !== "reload") {
    const resolved = new Set(state.sessionPaths.map(sessionIdOf));
    if ([...cause].some((id) => !resolved.has(id)))
      state.sessionPaths =
        await resolveConversationTranscriptPaths(conversationId);
  }
  const { sessionPaths } = state;
  const agents = await listSubagentEntries(sessionPaths.map(subagentDirOf));
  const storedByPath = state.files;
  const byPath = new Map<string, FileScan>(storedByPath);

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
  const addedByDate = new Map<string, number>();
  for (const scan of byPath.values()) {
    const prev = storedByPath.get(scan.path);
    const { addedByDate: added, ...pricing } = priceFile(
      prev,
      scan.buckets,
      table,
    );
    for (const [date, cost] of added)
      addedByDate.set(date, (addedByDate.get(date) ?? 0) + cost);
    const row = { ...scan, ...pricing };
    rows.push(row);
    const repriced =
      prev === undefined ||
      prev.costUsd !== row.costUsd ||
      prev.unpricedModels.join("\0") !== row.unpricedModels.join("\0");
    if (changedPaths.has(scan.path) || repriced) toWrite.push(row);
  }
  const totals = totalsOf(rows);
  const current = state.totals;
  const same =
    current !== undefined &&
    current.costUsd === totals.costUsd &&
    current.tokens === totals.tokens &&
    current.cacheReadTokens === totals.cacheReadTokens &&
    current.agentCount === totals.agentCount;
  const spend = await spendOf(conversationId, state, cause, addedByDate);
  if (toWrite.length > 0 || !same) {
    try {
      await writeUsage(
        db,
        conversationId,
        toWrite,
        same ? null : totals,
        spend,
      );
    } catch (err) {
      // Whether it landed is unknown (or the conversation went: an FK
      // violation): the next pass reads the DB again rather than trust this.
      held.delete(conversationId);
      throw err;
    }
  }

  // What the DB now holds (only once the write landed: a failed one leaves the
  // held state as it was, and the next pass recomputes the same rows).
  for (const row of toWrite) state.files.set(row.path, row);
  state.totals = totals;
  // A job's pass keeps the held state current when there is one, and holds
  // none otherwise: a backfill reaches every conversation once.
  if (cause !== "reload" || held.has(conversationId))
    hold(conversationId, state);
}

/**
 * The pass's newly priced cost as account spend — empty when nothing was
 * priced, on a job's pass, or when no account is known. Asks the runtime only
 * when there is cost to file (one pid-file read, no database read).
 */
async function spendOf(
  conversationId: string,
  state: UsageState,
  cause: SyncCause,
  addedByDate: ReadonlyMap<string, number>,
): Promise<AccountSpend[]> {
  if (cause === "reload" || addedByDate.size === 0) return [];
  const running = await conversationRunningAccount(conversationId);
  if (running !== null) state.account = running;
  const accountId = state.account;
  if (accountId === null) return [];
  return [...addedByDate].map(([date, costUsd]) => ({
    accountId,
    date,
    costUsd,
  }));
}

// Per-conversation serialization: a sync already running for a conversation
// absorbs every request that arrives meanwhile into ONE trailing re-run (their
// causes merged), so a burst of appends (a streaming turn writes a line per
// content block) costs at most two passes, and two passes never race on the
// same rows — nor on the held state.
interface Running {
  /** The trailing re-run's cause, merged; null when none is due. */
  again: { ids: Set<string> } | "reload" | null;
  done: Promise<void>;
}
const running = new Map<string, Running>();

function merge(
  a: Running["again"],
  cause: SyncCause,
): NonNullable<Running["again"]> {
  if (a === "reload" || cause === "reload") return "reload";
  return { ids: new Set([...(a?.ids ?? []), ...cause]) };
}

/**
 * Bring a conversation's usage up to date, coalesced with any sync of it
 * already in flight. `writtenSessionIds`: the live recount's — the sessions
 * whose transcripts (or their sub-agents') were written, of a conversation its
 * caller just read as existing; omitted, the pass reads everything from the DB.
 * Resolves once a pass that started after this call has finished.
 */
export function requestUsageSync(
  conversationId: string,
  writtenSessionIds?: Iterable<string>,
): Promise<void> {
  const cause: SyncCause =
    writtenSessionIds === undefined ? "reload" : new Set(writtenSessionIds);
  const inFlight = running.get(conversationId);
  if (inFlight) {
    inFlight.again = merge(inFlight.again, cause);
    return inFlight.done;
  }
  const entry: Running = { again: null, done: Promise.resolve() };
  entry.done = (async () => {
    try {
      let next: SyncCause | null = cause;
      while (next !== null) {
        await syncConversationUsage(conversationId, next);
        const again: Running["again"] = entry.again;
        entry.again = null;
        next = again === null || again === "reload" ? again : again.ids;
      }
    } finally {
      running.delete(conversationId);
    }
  })();
  running.set(conversationId, entry);
  return entry.done;
}
