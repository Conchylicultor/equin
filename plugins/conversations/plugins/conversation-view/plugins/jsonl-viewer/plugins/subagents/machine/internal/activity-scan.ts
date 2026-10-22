import type { LastStep, SubagentActivityRow } from "../../core";
import {
  evictMetaCache,
  listSubagents,
  readMeta,
  statIfPresent,
  subagentDirs,
  signaturePathsOf,
  subagentWatchDirs,
  type SubagentEntry,
} from "./discovery";
import { readTail } from "./tail-read";
import { readUsageSince, type UsageScan } from "./usage-read";
import { evictWorkflowJournals, readWorkflowReports } from "./workflow-journal";

/** What we remember about one sub-agent's transcript between scans. */
interface TranscriptState {
  mtimeMs: number;
  size: number;
  lastStep: LastStep | null;
  turnEnded: boolean;
  newestTurnLineAt: string | null;
  lastActivityAt: string;
  usage: UsageScan;
}

/** A sub-agent with no transcript yet has spent nothing. */
const NO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };

/**
 * Per-scope incremental scan state — the reason a change costs ONE bounded tail
 * read (plus the bytes appended since, for the token total) rather than a
 * re-parse of every sub-agent transcript.
 *
 * Each entry holds the `(mtime, size)` the row was built from; a scan re-stats
 * (cheap, a handful of files) and only re-reads the tail of the files whose stat
 * actually moved. Dropped when nothing is subscribed to the conversation.
 */
const scans = new Map<string, Map<string, TranscriptState>>();

export function evictActivityScan(scope: string): void {
  scans.delete(scope);
  evictMetaCache(scope);
  evictWorkflowJournals(scope);
}

/**
 * The files this conversation's activity signature is taken over, and the dirs
 * to watch — both from ONE walk, so the watched set and the signed set cannot
 * describe different listings.
 */
export async function resolveActivityTargets(
  conversationId: string,
): Promise<{ paths: string[]; dirs: string[] }> {
  const roots = await subagentDirs(conversationId);
  const listing = await listSubagents(roots);
  return {
    paths: signaturePathsOf(listing),
    dirs: subagentWatchDirs(roots, listing.runs),
  };
}

/**
 * Every sub-agent in `dirs`, with what it is doing right now.
 *
 * Takes its directories rather than fetching them, so the set it may read is
 * decided in exactly one place (`subagentDirs`) and cannot be widened here.
 *
 * **One unreadable meta costs one row, never the list.** A sub-agent whose meta
 * the schema rejects becomes an `undescribed` row carrying everything the
 * filesystem still knows — before this, it threw inside the loader and NO card
 * in the conversation rendered. A sub-agent whose meta has not been written yet
 * gets no row at all: it is not yet known to exist under any name, and the card
 * renders that absence as "starting".
 */
export async function scanActivityIn(
  scope: string,
  dirs: readonly string[],
): Promise<SubagentActivityRow[]> {
  const { entries, runs } = await listSubagents(dirs);
  const reports = await readWorkflowReports(scope, runs);

  let state = scans.get(scope);
  if (!state) {
    state = new Map();
    scans.set(scope, state);
  }

  const rows: SubagentActivityRow[] = [];
  const live = new Set<string>();

  for (const entry of entries) {
    const read = await readMeta(scope, entry.metaPath);
    if (read.kind === "absent") continue;
    live.add(entry.agentId);

    const transcript = await refreshTranscriptState(entry, state);
    const base = {
      agentId: entry.agentId,
      startedAt: read.startedAt,
      lastActivityAt: transcript?.lastActivityAt ?? read.startedAt,
      lastStep: transcript?.lastStep ?? null,
      // No transcript yet: no turn has been taken, let alone ended.
      turnEnded: transcript?.turnEnded ?? false,
      newestTurnLineAt: transcript?.newestTurnLineAt ?? null,
      // A copy: the scan's totals are this cache's, and a row once handed out
      // must not change under whoever holds it.
      usage: { ...(transcript?.usage.fold.totals ?? NO_USAGE) },
      ...(entry.workflowRunId === undefined
        ? {}
        : {
            workflow: {
              runId: entry.workflowRunId,
              reported:
                reports.get(entry.workflowRunId)?.has(entry.agentId) ?? false,
            },
          }),
    };

    if (read.kind === "unreadable") {
      rows.push({ kind: "undescribed", ...base, reason: read.reason });
      continue;
    }
    const { meta } = read;
    rows.push({
      kind: "described",
      ...base,
      agentType: meta.agentType,
      description: meta.description,
      toolUseId: meta.toolUseId,
      name: meta.name,
      model: meta.model,
      requestShape: meta.requestShape,
      spawnDepth: meta.spawnDepth,
      parentAgentId: meta.parentAgentId,
      workflowPhase: meta.workflowPhase,
    });
  }

  for (const agentId of [...state.keys()]) {
    if (!live.has(agentId)) state.delete(agentId);
  }

  rows.sort(
    (a, b) =>
      a.startedAt.localeCompare(b.startedAt) ||
      a.agentId.localeCompare(b.agentId),
  );
  return rows;
}

/** `scanActivityIn`, bound to a conversation's own anchored directories. */
export async function scanActivity(
  conversationId: string,
): Promise<SubagentActivityRow[]> {
  return scanActivityIn(conversationId, await subagentDirs(conversationId));
}

/**
 * The one tail read. Re-stat is cheap and always runs; the read happens only
 * when the file actually moved since the row was last built.
 */
async function refreshTranscriptState(
  entry: SubagentEntry,
  state: Map<string, TranscriptState>,
): Promise<TranscriptState | null> {
  const st = await statIfPresent(entry.transcriptPath);
  if (st === null) return null;

  const cached = state.get(entry.agentId);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    return cached;
  }
  const fresh: TranscriptState = {
    mtimeMs: st.mtimeMs,
    size: st.size,
    ...(await readTail(entry.transcriptPath, st.size)),
    lastActivityAt: new Date(st.mtimeMs).toISOString(),
    // The total is the one reading that needs every line, so it alone reads
    // incrementally from where the last scan stopped (`readUsageSince`).
    usage: await readUsageSince(entry.transcriptPath, st.size, cached?.usage),
  };
  state.set(entry.agentId, fresh);
  return fresh;
}
