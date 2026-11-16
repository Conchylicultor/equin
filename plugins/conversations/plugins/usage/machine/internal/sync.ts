import { basename, dirname } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "@plugins/database/server";
import { resolveConversationTranscriptPaths } from "@plugins/conversations/plugins/transcript-watcher/server";
import { conversationRunningAccount } from "@plugins/conversations/server";
import {
  listSubagentEntries,
  subagentDirOf,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/machine";
import {
  UNKNOWN_ACCOUNT,
  isRepoProjectDir,
  sessionSpendSource,
  type SeenEntry,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import { ensureModelRates } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import {
  advanceFile,
  agentCountOf,
  isLegacyScan,
  spendHourKey,
  tokenDelta,
  type FileScan,
} from "./scan";
import {
  writeUsage,
  type AccountUsage,
  type ConversationSourceFacts,
} from "./write";
import { releaseSessions } from "./session-sync";
import { rekeyStoredRows } from "./transcript-key";
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
//      Stored rows are matched to those files by transcript, not by path
//      (`transcript-key.ts`): a row under an old spelling of the file's
//      project dir is taken over, never counted again from zero;
//   2. fold each file's NEW bytes into its stored scan state (an append read),
//      or — when a session file joins the chain, or was counted before a
//      message counted at its largest output (`isLegacyScan`) — re-read every
//      session file through ONE seen-set, because a resumed / forked session's
//      new file copies the history before it;
//   3. take each changed file row's whole-token delta (`tokenDelta`) — what
//      the pass counted, negative where a chain re-read took tokens back;
//   4. file it to the token ledger (infra/claude-cli/usage-ledger's
//      `claude_usage_hours`), per hour, model and speed, under the
//      conversation's `conv:` source and the Claude account that spent it: a
//      live pass runs right after the agent's own append, so the account its
//      runtime runs it on NOW is the one the tokens were drawn from; a job
//      pass (the backfill) cannot know, and files them under
//      `UNKNOWN_ACCOUNT` — in the same statement as the file rows and the
//      agent count, then price any model first seen (`ensureModelRates`).
//      A session file counted for the first time may already be in the
//      ledger under `session:<id>`, read by the ledger-only path while no
//      conversation owned it (session-sync.ts — the first appends of every
//      launch arrive before the reconciler records the session id): the
//      conversation adopts it, deleting those rows in the same statement.
//
// No dollars here: the Cost column is derived from the ledger by the database
// (server/internal/cost-triggers.ts), priced by `claude_spend_hours_v` — the
// one pricing function every cost surface reads.

/**
 * One conversation's usage state as this process last read or wrote it: its
 * chain's transcript files as last resolved, every file row, and the totals.
 *
 * Held, not re-read per append: this module is the ONLY writer of
 * `conversation_usage_files` and of the agent count (every path — the live
 * recount, the backfill — goes through {@link requestUsageSync}, serialized
 * per conversation), so what it wrote is what the DB holds. A live append then
 * costs the bytes it appended and one write — not a re-read of the
 * conversation, its chain, its file rows and its totals every time
 * (2026-11-06: ~8 DB round trips per append, 2,023 syncs in 52 min on main).
 */
interface UsageState {
  sessionPaths: string[];
  files: Map<string, FileScan>;
  /** The agent count the DB holds (`undefined`: no row yet). */
  agentCount: number | undefined;
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
    agentCount: totals?.agentCount,
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
  const reachedPaths = [
    ...sessionPaths,
    ...agents.map((a) => a.transcriptPath),
  ];
  const storedByPath = state.files;
  // The stored rows matched to what this pass reads by transcript, not by
  // path (`rekeyStoredRows`): a project dir renamed under its rows (the
  // data-root move) continues from the row's offset instead of counting the
  // file again from zero, and a transcript already counted under both
  // spellings gives the second count back.
  const { byPath, moved, dropped } = rekeyStoredRows(
    storedByPath,
    reachedPaths,
  );
  /** The row a path's delta is taken from: its own, or the one it took over. */
  const priorOf = (path: string): FileScan | undefined =>
    storedByPath.get(path) ?? moved.get(path);
  const removed = [
    ...[...moved.values()].map((r) => r.path),
    ...dropped.map((r) => r.path),
  ];
  // A session counted here for the first time may have been counted by the
  // ledger-only path while no conversation owned it (session-sync.ts): wait
  // out its passes, then drop what they filed in this pass's write.
  const adoptedIds = sessionPaths
    .filter((p) => !byPath.has(p))
    .map(sessionIdOf);
  await releaseSessions(adoptedIds);

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
  const reached = new Set(reachedPaths);
  for (const scan of byPath.values()) {
    if (!reached.has(scan.path) && isLegacyScan(scan))
      changed.push({ ...scan, tailHashes: [] });
  }
  // A row taken over under its new path is written there even when its file
  // did not move (its old path's row goes in the same statement).
  for (const path of moved.keys()) {
    if (!changed.some((scan) => scan.path === path))
      changed.push(byPath.get(path)!);
  }

  for (const scan of changed) byPath.set(scan.path, scan);
  // Only a session whose file this pass counts is adopted (one whose file is
  // gone has nothing here to replace what the other path filed).
  const adopted = adoptedIds
    .filter((id) =>
      sessionPaths.some((p) => sessionIdOf(p) === id && byPath.has(p)),
    )
    .map(sessionSpendSource);
  const toWrite = changed;
  const agentCount = agentCountOf(byPath.values());
  // Only the agent count is the sync's to write: cost and tokens are derived
  // from the token ledger by the database (server/internal/cost-triggers.ts).
  const same = state.agentCount === agentCount;
  const counted = [
    ...changed.flatMap((scan) =>
      tokenDelta(priorOf(scan.path)?.buckets, scan.buckets),
    ),
    ...dropped.flatMap((scan) => tokenDelta(scan.buckets, [])),
  ];
  const accountId = await accountOf(
    conversationId,
    state,
    cause,
    counted.length > 0,
  );
  const usage: AccountUsage[] = counted.map((b) => ({
    accountId: accountId ?? UNKNOWN_ACCOUNT,
    hour: new Date(spendHourKey(b)),
    model: b.model,
    speed: b.speed,
    tokens: {
      input: b.input,
      output: b.output,
      cacheRead: b.cacheRead,
      cacheCreate5m: b.cacheCreate5m,
      cacheCreate1h: b.cacheCreate1h,
    },
  }));
  const source =
    usage.length > 0 && !sourced.has(conversationId)
      ? await sourceFacts(sessionPaths)
      : null;
  if (toWrite.length > 0 || removed.length > 0 || !same || adopted.length > 0) {
    try {
      await writeUsage(
        db,
        conversationId,
        toWrite,
        same ? null : agentCount,
        usage,
        source,
        adopted,
        removed,
      );
    } catch (err) {
      // Whether it landed is unknown (or the conversation went: an FK
      // violation): the next pass reads the DB again rather than trust this.
      held.delete(conversationId);
      throw err;
    }
  }

  if (source !== null) sourced.add(conversationId);
  await ensureModelRates(db, new Set(usage.map((row) => row.model)));

  // What the DB now holds (only once the write landed: a failed one leaves the
  // held state as it was, and the next pass recomputes the same rows).
  for (const path of removed) state.files.delete(path);
  for (const row of toWrite) state.files.set(row.path, row);
  state.agentCount = agentCount;
  // A job's pass keeps the held state current when there is one, and holds
  // none otherwise: a backfill reaches every conversation once.
  if (cause !== "reload" || held.has(conversationId))
    hold(conversationId, state);
}

/**
 * The Claude account the pass's newly counted usage was drawn from — `null`
 * on a job's pass (it cannot know), when there is nothing to file, or when no
 * account is known. Asks the runtime only when there is something to file
 * (one pid-file read, no database read).
 */
async function accountOf(
  conversationId: string,
  state: UsageState,
  cause: SyncCause,
  anything: boolean,
): Promise<string | null> {
  if (cause === "reload" || !anything) return null;
  const running = await conversationRunningAccount(conversationId);
  if (running !== null) state.account = running;
  return state.account;
}

/**
 * Conversations whose token-ledger source row this process has written: the
 * row only ever gains facts (a chain's first session file stays its first), so
 * it is written once per process, not on every append.
 */
const sourced = new Set<string>();

/**
 * The conversation's source row: the encoded Claude project dir its chain's
 * first session file lives in, and whether that is one of this repo's
 * checkouts (Stats' repo scope). No title: a conversation is named by its live
 * row, never by a snapshot.
 */
async function sourceFacts(
  sessionPaths: readonly string[],
): Promise<ConversationSourceFacts> {
  const [first] = sessionPaths;
  if (first === undefined)
    return { projectDir: null, isRepo: false, title: null };
  const projectDir = basename(dirname(first));
  const repoBasename = basename(await ensureMainWorktreeRoot());
  return {
    projectDir,
    isRepo: isRepoProjectDir(projectDir, repoBasename),
    title: null,
  };
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
