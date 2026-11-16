import { join, relative, sep } from "node:path";
import { readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { writeAtomically, type DbExecutor } from "@plugins/database/server";
import { _conversationSessions } from "@plugins/conversations/plugins/session-chain/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import {
  TOKEN_KINDS,
  TOKEN_TIERS,
  UNKNOWN_ACCOUNT,
  conversationSpendSource,
  isRepoProjectDir,
  sessionSpendSource,
  type DayBucket,
  type SpendSource,
  type UsageTokens,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/core";
import {
  usageLedgerImport,
  usageLedgerRowsOf,
  usageSourcesUpsert,
  type UsageLedgerRow,
  type UsageSourceRow,
} from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/server";
import type { ArchiveEntry } from "./archive";
import { transcriptKey } from "./transcript-key";
import { spendHourKey, tokenDelta } from "./scan";
import {
  _claudeTranscriptScans,
  _claudeUsageHistoryImports,
  _conversationUsageFiles,
  type UsageHistoryImportSummary,
} from "../../server/internal/tables";

// ─── What this is ──────────────────────────────────────────────────────────────
//
// The token ledger's history, imported ONCE per database (design:
// research/2026-11-16-global-unified-claude-cost.md § 3). The scanners count
// only what they read from now on; two records hold what came before:
//
// 1. **The conversations' own counts** (`conversation_usage_files.buckets`,
//    hour or legacy day buckets per file — vanished files included: a row
//    outlives its file). Each conversation's ledger is brought to exactly its
//    rounded buckets (`tokenDelta`, the rounding the sync files its deltas
//    with): what it holds minus what the sync already filed since the ledger
//    began, so the deltas it files from here on telescope onto it.
//
// 2. **The permanent archive** (the legacy `sessions-<YYYY>.json` shards
//    Stats → Cost banked, read by `./archive.ts`): one entry per transcript
//    path ever seen, day buckets. An entry is imported
//    only when NO scanner covers its transcript — counting it twice is the one
//    thing this must not do. A transcript is matched by its session-relative
//    path (`transcriptKey`), never by its full path: the archive, the scan
//    rows and the disk may spell its project dir differently (the data-root
//    move renamed every project dir under the legacy data root on disk; the
//    archive and older rows keep the old name):
//    - a transcript with a `conversation_usage_files` or
//      `claude_transcript_scans` row is already counted (by (1), or by the
//      session scanner — which match their rows by the same key);
//    - a transcript still on disk, under any project dir, is the scanners' —
//      unless its session is equin's
//      (in a session chain) but no LIVE conversation owns it: a deleted
//      conversation's transcripts, which neither the conversation path (its
//      conversation is gone) nor the session path (the session is equin's)
//      will ever read;
//    - a path gone from disk can gain no scan row, so what is decided here
//      stays true after the import (a file deleted between the archive's last
//      capture and now has its tokens only in the archive: imported).
//    Its source: the conversation whose chain holds the session (the archive
//    snapshotted only a conversation's tail session, so a sub-agent's or an
//    earlier session's entry carries none), else the one the entry names, else
//    `session:<sessionId>`. Its bucket hours: 00:00 UTC of the day. Its
//    account: `UNKNOWN_ACCOUNT`. A `claude_usage_sources` row per source
//    (project dir, repo flag, the archived title).
//
// The legacy dollar ledger (`claude_spend_hours`) is gone by the time this
// runs: the migration that dropped it carried its `unattributed` dollars into
// `claude_account_spend_carryover`. The import main ran (2026-11-16) also
// attributed each remainder hour the ledger named one account for, from a
// copy of it (`claude_usage_import_accounts`) dropped once main had recorded
// the import; a database importing since (a fresh install) has no legacy
// ledger, so every remainder is `UNKNOWN_ACCOUNT`.
//
// A conversation's file rows hold each transcript once (`rekeyStoredRows`
// keeps them so; the drop-dollars group's claimed data migration collapsed
// the rows counted under both spellings before the move was matched by key),
// and the import refuses to run otherwise: it is never taken back.
//
// It runs only once the drop-dollars group's deferred contract has completed
// (`usageHistoryImportJob`): until then the previous backend may still be
// moving `conversation_usage_files` by full path.
//
// Every row is written with origin `imported` (`usageLedgerImport`), which no
// scanner's take-back reaches — adoption of a session by a conversation, and
// a source recounted whole, drop only the rows the scanners counted.
//
// **Exactly once**: under a transaction-scoped advisory lock, the record row
// (`claude_usage_history_imports`) is checked first and written in the same
// transaction as the rows, so a second run (a later boot, a concurrent one)
// files nothing. `conversation_usage_files` is locked against writes for the
// transaction (SHARE): a live sync files its delta in the statement that moves
// the file rows, so with both held still what (1) computes is exact.

/** The import this module performs — a different import is a different name. */
export const USAGE_HISTORY_IMPORT = "archive-and-conversations-v1";

/** Fixed advisory-lock key of the import ("usage history"). */
const IMPORT_LOCK = 0x75_68_69_73;

/** How many ledger rows one insert carries (16 bind parameters each). */
const WRITE_BATCH = 2_000;

export interface HistoryImportInputs {
  /** The permanent archive, keyed by transcript path (`loadCostArchive`). */
  archive: ReadonlyMap<string, ArchiveEntry>;
  /** The Claude projects dir every archived path lives under. */
  projectsDir: string;
  /**
   * Which of these transcripts (`transcriptKey`s) are on disk now, under any
   * project dir.
   */
  onDisk: (keys: readonly string[]) => Promise<ReadonlySet<string>>;
  /** This repo's main checkout basename (`isRepoProjectDir`). */
  repoBasename: string;
}

export type HistoryImportResult =
  | { kind: "imported"; summary: UsageHistoryImportSummary; models: string[] }
  | { kind: "already-imported" };

/** A transcript path's project dir and session id, read from where it lives. */
function locate(
  projectsDir: string,
  path: string,
): { projectDir: string; sessionId: string } {
  const parts = relative(projectsDir, path).split(sep);
  // `<dir>/<session>.jsonl`, or `<dir>/<session>/subagents/…/agent-x.jsonl`.
  const [projectDir, second] = parts;
  if (
    parts.length < 2 ||
    projectDir === undefined ||
    second === undefined ||
    projectDir === ".." ||
    (parts.length === 2 && !second.endsWith(".jsonl"))
  )
    throw new Error(
      `archived transcript ${path} is not under the Claude projects dir ${projectsDir}`,
    );
  return {
    projectDir,
    sessionId: parts.length === 2 ? second.slice(0, -".jsonl".length) : second,
  };
}

const emptyTokens = (): UsageTokens => ({
  input: { below: 0, above: 0 },
  output: { below: 0, above: 0 },
  cacheRead: { below: 0, above: 0 },
  cacheCreate5m: { below: 0, above: 0 },
  cacheCreate1h: { below: 0, above: 0 },
});

/** A rounded bucket as a ledger row under `source` (its hour, or 00:00 of its day). */
function rowOf(source: SpendSource, b: DayBucket): UsageLedgerRow {
  const tokens = emptyTokens();
  for (const kind of TOKEN_KINDS)
    for (const tier of TOKEN_TIERS) tokens[kind][tier] = b[kind][tier];
  return {
    accountId: UNKNOWN_ACCOUNT,
    hour: new Date(spendHourKey(b)),
    source,
    model: b.model,
    speed: b.speed,
    tokens,
  };
}

const keyOf = (r: UsageLedgerRow): string =>
  `${r.source}\0${r.hour.toISOString()}\0${r.model}\0${r.speed}`;

/**
 * Which of `keys` (`transcriptKey`s: `<sessionId>.jsonl`, `<sessionId>/…`)
 * are on disk under any project dir of `projectsDir`: one listing of the projects dir and of
 * each project dir (which sessions each holds), then a stat per key in the
 * dirs holding its session (only "no such file" means gone).
 */
export async function transcriptsOnDisk(
  projectsDir: string,
  keys: readonly string[],
): Promise<Set<string>> {
  const dirsOf = new Map<string, string[]>();
  let dirs;
  try {
    dirs = await readdir(projectsDir, { withFileTypes: true });
  } catch (err) {
    // Claude Code never ran on this computer: no transcript is on disk.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw err;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const at = join(projectsDir, dir.name);
    for (const name of await readdir(at)) {
      const session = name.endsWith(".jsonl") ? name.slice(0, -6) : name;
      const held = dirsOf.get(session) ?? [];
      if (!held.includes(at)) held.push(at);
      dirsOf.set(session, held);
    }
  }
  const out = new Set<string>();
  for (const key of keys) {
    const [segment = ""] = key.split("/");
    const session = segment.endsWith(".jsonl") ? segment.slice(0, -6) : segment;
    for (const dir of dirsOf.get(session) ?? []) {
      try {
        await stat(join(dir, key));
        out.add(key);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
    }
  }
  return out;
}

/**
 * Import the ledger's history into `exec`'s database, once (see the header).
 * Returns `already-imported` when this database holds the import's record.
 */
export async function importUsageHistory(
  exec: DbExecutor,
  inputs: HistoryImportInputs,
): Promise<HistoryImportResult> {
  const located = new Map(
    [...inputs.archive.keys()].map((path) => [
      path,
      locate(inputs.projectsDir, path),
    ]),
  );
  const present = await inputs.onDisk([
    ...new Set([...inputs.archive.keys()].map(transcriptKey)),
  ]);

  return exec.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${IMPORT_LOCK})`);
    const [done] = await tx
      .select({ name: _claudeUsageHistoryImports.name })
      .from(_claudeUsageHistoryImports)
      .where(eq(_claudeUsageHistoryImports.name, USAGE_HISTORY_IMPORT));
    if (done !== undefined) return { kind: "already-imported" };
    await tx.execute(sql`LOCK TABLE ${_conversationUsageFiles} IN SHARE MODE`);

    const rows: UsageLedgerRow[] = [];
    const sources: UsageSourceRow[] = [];

    // ── 1. The conversations' own counts ───────────────────────────────────
    const files = await tx
      .select({
        conversationId: _conversationUsageFiles.conversationId,
        path: _conversationUsageFiles.path,
        kind: _conversationUsageFiles.kind,
        buckets: _conversationUsageFiles.buckets,
      })
      .from(_conversationUsageFiles);
    const target = new Map<string, UsageLedgerRow>();
    const firstSessionFile = new Map<string, string>();
    const seen = new Map<string, string>();
    for (const file of files) {
      const transcript = `${file.conversationId}\0${transcriptKey(file.path)}`;
      const twin = seen.get(transcript);
      if (twin !== undefined)
        throw new Error(
          `conversation ${file.conversationId} counts one transcript twice (${twin} and ${file.path}): importing both would file its tokens twice, for good`,
        );
      seen.set(transcript, file.path);
      const source = conversationSpendSource(file.conversationId);
      if (file.kind === "session") {
        const prev = firstSessionFile.get(file.conversationId);
        if (prev === undefined || file.path < prev)
          firstSessionFile.set(file.conversationId, file.path);
      }
      for (const b of tokenDelta(undefined, file.buckets)) {
        const row = rowOf(source, b);
        const prev = target.get(keyOf(row));
        if (prev === undefined) {
          target.set(keyOf(row), row);
          continue;
        }
        for (const kind of TOKEN_KINDS)
          for (const tier of TOKEN_TIERS)
            prev.tokens[kind][tier] += row.tokens[kind][tier];
      }
    }
    const conversationIds = new Set(files.map((f) => f.conversationId));
    // What the sync filed since the ledger began, taken out of the target.
    const filed = await usageLedgerRowsOf(
      tx,
      [...conversationIds].map(conversationSpendSource),
    );
    for (const row of filed) {
      let remainder = target.get(keyOf(row));
      if (remainder === undefined) {
        remainder = {
          ...row,
          accountId: UNKNOWN_ACCOUNT,
          tokens: emptyTokens(),
        };
        target.set(keyOf(row), remainder);
      }
      for (const kind of TOKEN_KINDS)
        for (const tier of TOKEN_TIERS)
          remainder.tokens[kind][tier] -= row.tokens[kind][tier];
    }
    rows.push(...target.values());
    for (const [conversationId, path] of firstSessionFile) {
      // A row stored under its key (`transcript-key.ts`) names no project
      // dir: the sync that wrote it counted its tokens, and wrote the source
      // row with them.
      if (transcriptKey(path) === path) continue;
      const { projectDir } = locate(inputs.projectsDir, path);
      sources.push({
        source: conversationSpendSource(conversationId),
        projectDir,
        isRepo: isRepoProjectDir(projectDir, inputs.repoBasename),
        title: null,
      });
    }

    // ── 2. The archive's transcripts no scanner covers ─────────────────────
    const scanned = new Set(
      (
        await tx
          .select({ path: _claudeTranscriptScans.path })
          .from(_claudeTranscriptScans)
      ).map((r) => transcriptKey(r.path)),
    );
    const counted = new Set(files.map((f) => transcriptKey(f.path)));
    const sessionIds = [
      ...new Set([...located.values()].map((l) => l.sessionId)),
    ];
    const chained =
      sessionIds.length === 0
        ? []
        : await tx
            .select({
              sessionId: _conversationSessions.claudeSessionId,
              conversationId: _conversationSessions.conversationId,
              live: _conversations.id,
            })
            .from(_conversationSessions)
            .leftJoin(
              _conversations,
              eq(_conversations.id, _conversationSessions.conversationId),
            )
            .where(inArray(_conversationSessions.claudeSessionId, sessionIds))
            .orderBy(asc(_conversationSessions.seenAt));
    const tails =
      sessionIds.length === 0
        ? []
        : await tx
            .select({
              sessionId: _conversations.claudeSessionId,
              conversationId: _conversations.id,
            })
            .from(_conversations)
            .where(inArray(_conversations.claudeSessionId, sessionIds));
    /** The conversation each session ran under, first seen first. */
    const ownerOf = new Map<string, string>();
    const liveOwned = new Set<string>();
    for (const c of chained) {
      if (!ownerOf.has(c.sessionId)) ownerOf.set(c.sessionId, c.conversationId);
      if (c.live !== null) liveOwned.add(c.sessionId);
    }
    for (const t of tails) {
      if (t.sessionId === null) continue;
      if (!ownerOf.has(t.sessionId)) ownerOf.set(t.sessionId, t.conversationId);
      liveOwned.add(t.sessionId);
    }

    let archiveEntries = 0;
    let archiveSkipped = 0;
    for (const [path, { projectDir, sessionId }] of located) {
      const entry = inputs.archive.get(path);
      if (entry === undefined)
        throw new Error(`archive entry ${path} vanished`);
      const key = transcriptKey(path);
      const covered =
        counted.has(key) ||
        scanned.has(key) ||
        (present.has(key) &&
          !(ownerOf.has(sessionId) && !liveOwned.has(sessionId)));
      if (covered) {
        archiveSkipped += 1;
        continue;
      }
      archiveEntries += 1;
      const owner = ownerOf.get(sessionId) ?? entry.conversationId;
      const source =
        owner !== null
          ? conversationSpendSource(owner)
          : sessionSpendSource(sessionId);
      for (const b of tokenDelta(undefined, entry.partial.dayBuckets))
        rows.push(rowOf(source, b));
      sources.push({
        source,
        projectDir,
        isRepo:
          entry.isRepo || isRepoProjectDir(projectDir, inputs.repoBasename),
        title: entry.title,
      });
    }

    // ── Write, then record ─────────────────────────────────────────────────
    for (let at = 0; at < rows.length; at += WRITE_BATCH) {
      await writeAtomically(tx, [
        usageLedgerImport(tx, rows.slice(at, at + WRITE_BATCH)),
      ]);
    }
    for (let at = 0; at < sources.length; at += WRITE_BATCH) {
      await writeAtomically(tx, [
        usageSourcesUpsert(tx, sources.slice(at, at + WRITE_BATCH)),
      ]);
    }
    const summary: UsageHistoryImportSummary = {
      conversations: conversationIds.size,
      archiveEntries,
      archiveSkipped,
      rows: rows.length,
    };
    await tx
      .insert(_claudeUsageHistoryImports)
      .values({ name: USAGE_HISTORY_IMPORT, summary });
    return {
      kind: "imported",
      summary,
      models: [...new Set(rows.map((r) => r.model))],
    };
  });
}
