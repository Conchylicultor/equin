import { basename, dirname } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { union } from "drizzle-orm/pg-core";
import { db, type DbExecutor } from "@plugins/database/server";
import { _conversationSessions } from "@plugins/conversations/plugins/session-chain/server";
import {
  listSubagentEntries,
  subagentDirOf,
} from "@plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/subagents/machine";
import {
  UNKNOWN_ACCOUNT,
  isRepoProjectDir,
  sessionSpendSource,
  type SpendSource,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import {
  negateUsage,
  usageLedgerRowsOf,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import { ensureModelRates } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { activeClaudeAccountId } from "@plugins/infra/plugins/claude-cli/plugins/accounts/server";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { createKeyedMutex } from "@plugins/packages/plugins/keyed-mutex/core";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import {
  scanTranscript,
  spendHourKey,
  type TranscriptRead,
  type TranscriptScan,
} from "./scan";
import { transcriptKey } from "./transcript-key";
import {
  writeSessionUsage,
  type AccountUsage,
  type ConversationSourceFacts,
} from "./write";
import {
  _claudeTranscriptScans,
  type UsageFileKind,
} from "../../server/internal/tables";

// ─── What this is ──────────────────────────────────────────────────────────────
//
// The scanner's second path: the transcripts NO equin conversation owns — a
// Claude Code session the user ran themselves, and its sub-agents — counted
// for the token ledger alone, under the session's `session:<sessionId>`
// source, with a `claude_usage_sources` row (its project dir, and whether that
// is one of this repo's checkouts). No dollars, no totals: the ledger holds the
// counts, priced by `claude_spend_hours_v`; the scan state
// (`claude_transcript_scans`) is an offset and a tail per file.
//
// **Each transcript is in the ledger once.** A session is either equin's — the
// conversation path (`sync.ts`) counts it, under `conv:` — or not, and then
// this path does. "Equin's" is: its id was ever recorded in a conversation's
// session chain (those rows are never deleted, so a deleted conversation's
// transcripts are not recounted here), or it is a live conversation's tail.
//
// **Adoption.** A session can start here and become equin's: the status
// reconciler records a launched agent's session id only once its transcript
// exists, so the first appends of every equin session may arrive here first
// (and a user's session can be resumed by a conversation). The rule: the
// conversation wins, and takes the session over whole. Its sync, counting a
// session file for the first time, first waits out any pass of this path on
// that session (`releaseSessions`, the per-session mutex — after it, every
// pass here sees the session as equin's and stops), then deletes the
// session's ledger rows, source row and scan rows in the same statement that
// files the conversation's own count of the files from their start.
//
// **Account.** A live pass files under the account active when it reads (a
// session equin did not launch runs on whatever the user's terminal runs on;
// the active account is the best this host knows — the same rule as an exited
// agent's last tokens); a job's pass (the backfill) under `UNKNOWN_ACCOUNT`.
//
// Per-file dedup (each file's own counted entries), as Stats → Cost has
// always read them; only an equin conversation's chain is deduped
// across its files.

/** What a pass is for: a live append (the account is the active one) or a job's (unknown). */
export type SessionSyncCause = "live" | "job";

/**
 * One session's scan rows as this process last read or wrote them. Held only
 * while the session is known not to be equin's: a session the conversation
 * path adopts is dropped (`releaseSessions`) and re-checked on its next pass.
 */
interface SessionState {
  /** The session's scan rows by transcript (`transcriptKey`), as stored. */
  files: Map<string, TranscriptScan>;
}

const held = new Map<string, SessionState>();
const HELD_MAX = 256;

function hold(sessionId: string, state: SessionState): void {
  held.delete(sessionId);
  held.set(sessionId, state);
  for (const oldest of held.keys()) {
    if (held.size <= HELD_MAX) break;
    held.delete(oldest);
  }
}

/** Sources whose `claude_usage_sources` row this process has written. */
const sourced = new Set<SpendSource>();

/**
 * Serializes every pass over one session — this path's, and the conversation
 * path's adoption barrier (`releaseSessions`).
 */
const sessionMutex = createKeyedMutex();

/**
 * The ids of `sessionIds` that are equin's: recorded in any conversation's
 * session chain (deleted conversations included — the chain outlives them),
 * or a live conversation's current session.
 */
export async function equinSessionIds(
  exec: DbExecutor,
  sessionIds: readonly string[],
): Promise<Set<string>> {
  if (sessionIds.length === 0) return new Set();
  const chained = exec
    .select({ sessionId: _conversationSessions.claudeSessionId })
    .from(_conversationSessions)
    .where(inArray(_conversationSessions.claudeSessionId, [...sessionIds]));
  const tails = exec
    .select({ sessionId: _conversations.claudeSessionId })
    .from(_conversations)
    .where(inArray(_conversations.claudeSessionId, [...sessionIds]));
  const out = new Set<string>();
  for (const { sessionId } of await union(tails, chained))
    if (sessionId !== null) out.add(sessionId);
  return out;
}

async function loadState(
  exec: DbExecutor,
  source: SpendSource,
): Promise<SessionState> {
  const rows = await exec
    .select({
      path: _claudeTranscriptScans.path,
      kind: _claudeTranscriptScans.kind,
      offset: _claudeTranscriptScans.offset,
      tailHashes: _claudeTranscriptScans.tailHashes,
    })
    .from(_claudeTranscriptScans)
    .where(eq(_claudeTranscriptScans.source, source));
  return { files: furthestByKey(rows) };
}

/**
 * A session's scan rows by transcript (`transcriptKey`): a row written before
 * the table stored keys (an absolute path) continues from its offset, and of
 * two rows of one transcript — its absolute row, kept until the previous
 * backend is gone (`keyTranscriptScans`), beside the keyed row this code
 * writes — the one read furthest (a tie: the keyed one).
 */
export function furthestByKey<R extends { path: string; offset: number }>(
  rows: readonly R[],
): Map<string, R> {
  const out = new Map<string, R>();
  for (const row of rows) {
    const key = transcriptKey(row.path);
    const prev = out.get(key);
    if (
      prev === undefined ||
      row.offset > prev.offset ||
      (row.offset === prev.offset && row.path === key)
    )
      out.set(key, row);
  }
  return out;
}

/** The session's source row: its encoded project dir, and whether that is one of this repo's checkouts. */
async function sourceFacts(
  sessionPath: string,
): Promise<ConversationSourceFacts> {
  const projectDir = basename(dirname(sessionPath));
  const repoBasename = basename(await ensureMainWorktreeRoot());
  return {
    projectDir,
    isRepo: isRepoProjectDir(projectDir, repoBasename),
    title: null,
  };
}

/**
 * Bring one session's ledger count up to date: its session file
 * (`sessionPath`, `<projects>/<dir>/<sessionId>.jsonl`) and every sub-agent
 * transcript below it, each read from where it was last read. A session that
 * is equin's is skipped (the conversation path counts it).
 *
 * A file rewritten shorter than it was read recounts the whole source: what
 * the ledger holds for it is taken back (`usageLedgerRowsOf`, negated) and
 * every file is read from its start, in one write. A file of the source gone by
 * then cannot be re-read, so its tokens go with the take-back — a rewritten
 * transcript has not been observed; this keeps the count exact for what is on
 * disk rather than double.
 *
 * Exported for the tests, which drive it against a throwaway database; the
 * app goes through {@link requestSessionSync}, which serializes per session.
 */
export async function syncSessionUsage(
  exec: DbExecutor,
  sessionId: string,
  sessionPath: string,
  cause: SessionSyncCause,
): Promise<void> {
  const source = sessionSpendSource(sessionId);
  const kept = cause === "live" ? held.get(sessionId) : undefined;
  if (kept === undefined && (await equinSessionIds(exec, [sessionId])).size) {
    held.delete(sessionId);
    return;
  }
  const state = kept ?? (await loadState(exec, source));
  const agents = await listSubagentEntries([subagentDirOf(sessionPath)]);
  const paths = new Map<string, UsageFileKind>([[sessionPath, "session"]]);
  for (const agent of agents) paths.set(agent.transcriptPath, "subagent");

  const reads = new Map<string, TranscriptRead>();
  for (const [path, kind] of paths)
    reads.set(
      path,
      await scanTranscript(path, kind, state.files.get(transcriptKey(path))),
    );
  const recount = [...reads.values()].some((r) => r.status === "shrunk");
  let takeBack: AccountUsage[] = [];
  if (recount) {
    takeBack = negateUsage(await usageLedgerRowsOf(exec, [source]));
    for (const [path, kind] of paths)
      reads.set(path, await scanTranscript(path, kind, undefined));
  }

  const scans: TranscriptScan[] = [];
  const counted: AccountUsage[] = [];
  for (const read of reads.values()) {
    if (read.status !== "read") continue;
    // Stored under its key, never its absolute path (`transcript-key.ts`).
    scans.push({ ...read.scan, path: transcriptKey(read.scan.path) });
    for (const b of read.counted)
      counted.push({
        accountId: UNKNOWN_ACCOUNT,
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
      });
  }
  if (scans.length === 0 && takeBack.length === 0) {
    if (cause === "live" || held.has(sessionId)) hold(sessionId, state);
    return;
  }
  const accountId =
    cause === "live" && counted.length > 0
      ? await activeClaudeAccountId()
      : UNKNOWN_ACCOUNT;
  const usage = [...takeBack, ...counted.map((row) => ({ ...row, accountId }))];
  const facts =
    counted.length > 0 && !sourced.has(source)
      ? await sourceFacts(sessionPath)
      : null;
  try {
    await writeSessionUsage(exec, source, scans, usage, facts);
  } catch (err) {
    // Whether it landed is unknown: the next pass reads the DB again.
    held.delete(sessionId);
    throw err;
  }
  if (facts !== null) sourced.add(source);
  await ensureModelRates(exec, new Set(counted.map((row) => row.model)));
  for (const scan of scans) state.files.set(scan.path, scan);
  if (cause === "live" || held.has(sessionId)) hold(sessionId, state);
}

/**
 * Bring a session's ledger count up to date (see {@link syncSessionUsage}),
 * after every pass already asked for it — passes over one session never
 * overlap, nor with a conversation's adoption of it.
 */
export function requestSessionSync(
  sessionId: string,
  sessionPath: string,
  cause: SessionSyncCause,
): Promise<void> {
  return sessionMutex.run(sessionId, () =>
    syncSessionUsage(db, sessionId, sessionPath, cause),
  );
}

/**
 * The conversation path's adoption barrier: resolves once no pass of this
 * path over `sessionIds` is running, with their held state dropped. Called
 * by a conversation's sync that is about to count those sessions' files for
 * the first time — the session is equin's by then, so every later pass here
 * stops at its ownership check, and what the earlier ones filed is what the
 * sync then deletes (`writeUsage`'s `adopted`).
 */
export async function releaseSessions(
  sessionIds: Iterable<string>,
): Promise<void> {
  await Promise.all(
    [...new Set(sessionIds)].map((id) =>
      sessionMutex.run(id, async () => {
        held.delete(id);
      }),
    ),
  );
}
