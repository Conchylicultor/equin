import { basename, join } from "node:path";
import { z } from "zod";
import { eq, isNull } from "drizzle-orm";
import { readdir, stat } from "@plugins/packages/plugins/timed-fs/core";
import {
  CLAUDE_PROJECTS_DIR,
  isHostSingleton,
} from "@plugins/infra/plugins/paths/server";
import { db, deferredContractSettled } from "@plugins/database/server";
import { defineJob } from "@plugins/infra/plugins/jobs/server";
import { defineWarmup } from "@plugins/infra/plugins/warmup/server";
import { _conversations } from "@plugins/tasks/plugins/tasks-core/server";
import { ensureModelRates } from "@plugins/infra/plugins/claude-cli/plugins/usage-ledger/plugins/pricing/server";
import { ensureMainWorktreeRoot } from "@plugins/infra/plugins/worktree/server";
import { requestUsageSync } from "./sync";
import { importUsageHistory, transcriptsOnDisk } from "./history-import";
import { loadCostArchive } from "./archive";
import {
  equinSessionIds,
  furthestByKey,
  requestSessionSync,
} from "./session-sync";
import { keyTranscriptScans } from "./scan-keys";
import { transcriptKey } from "./transcript-key";
import {
  _claudeTranscriptScans,
  _conversationUsageExt,
} from "../../server/internal/tables";

/**
 * The one serial lane both transcript-reading jobs share, so a backfill reads
 * one transcript set at a time — a conversation's or a session's.
 */
const TRANSCRIPT_READS = "conversations.usage.transcript-reads";

/**
 * One conversation's usage sync, as a job — how the backfill reaches
 * `requestUsageSync`. Keyed on the conversation, so re-enqueueing one
 * that is already pending collapses; serial, so a backfill of every
 * conversation reads one conversation's transcripts at a time.
 */
export const usageSyncJob = defineJob({
  name: "conversations.usage.sync",
  description:
    "Recounts one conversation's token usage and launched sub-agents from its transcripts.",
  // seconds: local reads of one conversation's transcripts (the appended bytes,
  // or every file of a chain that has not been read yet) — no network, no spawn.
  hold: "seconds",
  input: z.object({ conversationId: z.string() }),
  event: z.never(),
  dedup: { key: ({ conversationId }) => conversationId },
  serial: { with: TRANSCRIPT_READS },
  slowThresholdMs: 30_000,
  run: async ({ input: { conversationId } }) => {
    await requestUsageSync(conversationId);
  },
});

/**
 * Seeds the usage of every conversation that has none yet: those that predate
 * this plugin, and a fork's conversations its source had not counted. Every
 * conversation gets a row once synced (zeros when it has no transcript left),
 * so a later boot finds nothing to do.
 */
export const usageBackfillJob = defineJob({
  name: "conversations.usage.backfill",
  description:
    "Queues a usage count for every conversation that has not been counted yet.",
  // instant: one indexed anti-join and N queue inserts.
  hold: "instant",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  run: async () => {
    const rows = await db
      .select({ id: _conversations.id })
      .from(_conversations)
      .leftJoin(
        _conversationUsageExt,
        eq(_conversationUsageExt.conversationId, _conversations.id),
      )
      .where(isNull(_conversationUsageExt.conversationId));
    for (const { id } of rows)
      await usageSyncJob.enqueue({ conversationId: id });
  },
});

/**
 * One session's ledger-only count (a session no equin conversation owns —
 * `session-sync.ts`), as a job: how the session backfill reaches
 * `requestSessionSync`. Keyed on the session; serial in the transcript-read
 * lane, so the first backfill of a host — every Claude Code session on it,
 * gigabytes — reads one session at a time, a chunk at a time.
 */
export const usageSessionSyncJob = defineJob({
  name: "conversations.usage.session-sync",
  description:
    "Counts the tokens of one Claude Code session equin did not launch into the usage ledger, from its transcripts.",
  // seconds: local reads of one session's transcripts — what was appended
  // since its last read, or the whole files the first time.
  hold: "seconds",
  input: z.object({ sessionId: z.string(), path: z.string() }),
  event: z.never(),
  dedup: { key: ({ sessionId }) => sessionId },
  serial: { with: TRANSCRIPT_READS },
  slowThresholdMs: 30_000,
  run: async ({ input: { sessionId, path } }) => {
    await requestSessionSync(sessionId, path, "job");
  },
});

/** A top-level session transcript: `<projects>/<dir>/<uuid>.jsonl`. */
const SESSION_FILE_RE = /^([0-9a-f-]{36})\.jsonl$/;

/**
 * Queues a ledger-only count of every session transcript on the host no
 * conversation owns that is not counted up to its end: one with no scan row
 * (never read — the first boot reads every one), or one whose file grew past
 * its row's offset (appended while no backend listened). A session equin ran
 * is the conversation path's, never queued.
 *
 * On the host singleton only, like the live recount: one scanner per host. A
 * listing of the projects dir, a stat per session file and two reads — no
 * transcript bytes.
 */
export const usageSessionBackfillJob = defineJob({
  name: "conversations.usage.session-backfill",
  description:
    "Queues a usage-ledger count for every Claude Code session on this computer that equin did not launch and has not counted to its end.",
  // seconds: a readdir per project dir and a stat per session file (thousands).
  hold: "seconds",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  slowThresholdMs: 30_000,
  run: async () => {
    if (!isHostSingleton()) return;
    const files = new Map<string, string>();
    let dirs;
    try {
      dirs = await readdir(CLAUDE_PROJECTS_DIR, { withFileTypes: true });
    } catch (err) {
      // Claude Code never ran on this computer: no session to count.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const at = join(CLAUDE_PROJECTS_DIR, dir.name);
      for (const name of await readdir(at)) {
        const match = SESSION_FILE_RE.exec(name);
        if (match) files.set(match[1]!, join(at, name));
      }
    }
    const owned = await equinSessionIds(db, [...files.keys()]);
    const read = furthestByKey(
      await db
        .select({
          path: _claudeTranscriptScans.path,
          offset: _claudeTranscriptScans.offset,
        })
        .from(_claudeTranscriptScans)
        .where(eq(_claudeTranscriptScans.kind, "session")),
    );
    for (const [sessionId, path] of files) {
      if (owned.has(sessionId)) continue;
      const offset = read.get(transcriptKey(path))?.offset;
      if (offset !== undefined && (await stat(path)).size <= offset) continue;
      await usageSessionSyncJob.enqueue({ sessionId, path });
    }
  },
});

/**
 * The token ledger's one-shot history import (`history-import.ts`): the
 * conversations' pre-ledger counts and the permanent archive's transcripts no
 * scanner covers, filed once per database and recorded in
 * `claude_usage_history_imports`. On the host singleton only — the archive is
 * the host's, and one database (main's) is the archive from then on; a fork
 * inherits the imported rows and the record with them.
 */
export const usageHistoryImportJob = defineJob({
  name: "conversations.usage.history-import",
  description:
    "Imports the usage history from before the token ledger (each conversation's earlier count, and the archived usage of transcripts already deleted) into the ledger, once.",
  // minutes: a stat per archived transcript (thousands), then one transaction
  // reading every conversation's file rows and writing tens of thousands of
  // ledger rows.
  hold: "minutes",
  inProcess:
    "Restartable from scratch: it is one transaction recorded in the same transaction, so a run cut short filed nothing and the next run imports it all; local file and DB reads only.",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  slowThresholdMs: 600_000,
  run: async () => {
    if (!isHostSingleton()) return;
    // Not while the previous backend may still write: until the schema's
    // deferred contract has run (the drop-dollars group's, on the deploy that
    // brings this import), code that matches usage file rows by full path can
    // still be connected, adding rows the import would file for good — and
    // the contract's re-run of the group's claimed data is what collapses them.
    // Awaited, not polled: the database boot settles it once.
    const contract = await deferredContractSettled();
    if (contract.kind !== "settled")
      throw new Error(
        contract.kind === "failed"
          ? "the usage history import waits on the schema's deferred contract, which failed this boot (the next boot retries it)"
          : "the usage history import runs in the serving backend, which owns the schema's deferred contract",
        contract.kind === "failed" ? { cause: contract.error } : undefined,
      );
    const result = await importUsageHistory(db, {
      archive: await loadCostArchive(),
      projectsDir: CLAUDE_PROJECTS_DIR,
      onDisk: (keys) => transcriptsOnDisk(CLAUDE_PROJECTS_DIR, keys),
      repoBasename: basename(await ensureMainWorktreeRoot()),
    });
    if (result.kind === "imported") await ensureModelRates(db, result.models);
  },
});

/**
 * Rewrites the `claude_transcript_scans` rows still stored under an absolute
 * path to their transcript key (`scan-keys.ts`) — once no backend older than
 * keys is connected. Not a data migration: one runs at boot while the previous
 * backend still serves, and that backend matches scan rows by absolute path —
 * a row keyed under it would be counted again from zero. Until then the
 * scanners read both spellings (`furthestByKey`) and write the key. Host
 * singleton only, like the scanners; a no-op once every row is keyed.
 */
export const usageScanKeysJob = defineJob({
  name: "conversations.usage.scan-keys",
  description:
    "Rewrites the usage scan rows of Claude Code sessions still stored under an absolute transcript path to the session-relative key, once the previous backend is gone.",
  // minutes: it waits out the schema's deferred contract (the previous backend
  // draining), then two statements over a few hundred rows.
  hold: "minutes",
  inProcess:
    "Restartable from scratch: one idempotent transaction; local DB only.",
  input: z.object({}).default({}),
  event: z.never(),
  dedup: "singleton",
  slowThresholdMs: 600_000,
  run: async () => {
    if (!isHostSingleton()) return;
    // Awaited, not polled: the database boot settles it once.
    const contract = await deferredContractSettled();
    if (contract.kind !== "settled")
      throw new Error(
        contract.kind === "failed"
          ? "keying the usage scan rows waits on the schema's deferred contract, which failed this boot (the next boot retries it)"
          : "keying the usage scan rows runs in the serving backend, which owns the schema's deferred contract",
        contract.kind === "failed" ? { cause: contract.error } : undefined,
      );
    await keyTranscriptScans(db);
  },
});

// A declared warm-up rather than an `onReady` enqueue: deferred past
// serving-ready and throttled. `worktree` scope — usage lives in each backend's
// own DB; a fork inherits its source's rows, so it seeds only what was missing.
// The session backfill and the history import ride along, on the host
// singleton.
export const usageBackfillWarmup = defineWarmup({
  name: "conversations.usage.backfill",
  description:
    "Queues usage counts for conversations created before usage was tracked, and for the Claude Code sessions not counted yet.",
  scope: "worktree",
  run: async () => {
    await usageBackfillJob.enqueue({});
    // The sessions no conversation owns: counted by the host singleton only.
    if (isHostSingleton()) {
      await usageSessionBackfillJob.enqueue({});
      // The history before the ledger, imported once (a no-op once recorded).
      await usageHistoryImportJob.enqueue({});
      // Scan rows still stored under absolute paths, keyed (a no-op after).
      await usageScanKeysJob.enqueue({});
    }
  },
});
